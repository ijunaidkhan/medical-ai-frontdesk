import { Injectable } from '@nestjs/common';
import { describeBusinessHours, isOpenAt, type AiConfiguration, type TransferTarget } from '@frontdesk/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { Transaction } from 'kysely';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { KnowledgeRetriever } from '../knowledge/retriever.js';
import { CreateTaskDto } from '../tasks/tasks.dto.js';
import { TasksService } from '../tasks/tasks.service.js';
import type { ModelToolDefinition } from './model/language-model.js';
import type { AgentMode } from './prompt.js';
import { stripControl } from './sanitize.js';
import { callerIsFinished } from './farewell.js';
import { chooseTransferTarget } from './safety/escalation.js';

/** A conversation may create at most this many tasks through the receptionist's tool (escalation tasks are separate). */
export const MAX_TASKS_PER_CONVERSATION = 3;
/** Tool calls honoured in one caller turn; the rest are refused. */
export const MAX_TOOL_CALLS_PER_TURN = 4;

/** What the backend knows about the conversation's practice. Loaded by the backend, never supplied by the model. */
export interface AgentContext {
  practice: { name: string; phone: string | null; timezone: string };
  config: Pick<
    AiConfiguration,
    'greeting' | 'emergencyMessage' | 'crisisMessage' | 'urgentAction' | 'urgentTransferTargetId' | 'afterHoursAction' | 'afterHoursTransferTargetId' | 'businessHours'
  > & { extraUrgentPhrases: string[] };
  targets: TransferTarget[];
}

/** What tools change during one caller turn; applied to the conversation together with the reply. */
export interface TurnState {
  ended: boolean;
  handoffTargetId: string | null;
  createdTaskIds: string[];
}

export interface ToolRuntime {
  practiceId: string;
  conversationId: string;
  context: AgentContext;
  meta: RequestMeta;
  state: TurnState;
  /** Tasks the tool has already created in this conversation (before this turn). */
  tasksBefore: number;
  /** What the caller said in this turn. Used by rules the backend enforces itself, such as "only end when they say goodbye". */
  callerText: string;
}

export type ToolResult = { status: 'ok' | 'rejected'; result: Record<string, unknown> };

const TOOL_DEFINITIONS: Record<string, ModelToolDefinition> = {
  search_knowledge: {
    name: 'search_knowledge',
    description: 'Search the practice\'s approved information (services, prices, insurance, location, policies). Use before answering any practical question about the practice.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'What the caller wants to know, in a few plain words.' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
  get_practice_info: {
    name: 'get_practice_info',
    description: 'Get the practice name, phone number, opening hours, and whether it is open right now.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  create_staff_task: {
    name: 'create_staff_task',
    description:
      'Pass a message or callback request to the practice staff. Ask the caller for their name and phone number first. Returns ok only if it was really saved.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['callback', 'message', 'question', 'other'] },
        title: { type: 'string', description: 'A short summary for staff, for example "Wants an appointment".' },
        details: { type: 'string', description: 'What the caller said they need, in the caller\'s own terms. No medical opinions.' },
        contactName: { type: 'string' },
        contactPhone: { type: 'string', description: 'International format, for example +14155550123.' },
      },
      required: ['type', 'title', 'contactPhone'],
      additionalProperties: false,
    },
  },
  request_human_handoff: {
    name: 'request_human_handoff',
    description: 'Hand the conversation to a person because the caller asks for one.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why, in a few words.' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  end_conversation: {
    name: 'end_conversation',
    description: 'End the conversation once the caller is finished.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const TOOLS_BY_MODE: Record<AgentMode, readonly string[]> = {
  normal: ['search_knowledge', 'get_practice_info', 'create_staff_task', 'request_human_handoff', 'end_conversation'],
  // After an emergency or urgent reply the receptionist may only take a callback request.
  message_only: ['create_staff_task', 'end_conversation'],
};

const pickString = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  const text = typeof value === 'string' ? stripControl(value) : '';
  return text.trim() !== '' ? text : undefined;
};

/**
 * The receptionist's tools. Each one validates what the model asked for and does
 * its narrow job inside the practice-scoped transaction it is given: the tenant
 * comes from the conversation, there is no practice argument a model could fill in.
 */
@Injectable()
export class AgentTools {
  constructor(
    private readonly retriever: KnowledgeRetriever,
    private readonly tasks: TasksService,
  ) {}

  definitions(mode: AgentMode): ModelToolDefinition[] {
    return TOOLS_BY_MODE[mode].map((name) => TOOL_DEFINITIONS[name]!);
  }

  isAllowed(mode: AgentMode, name: string): boolean {
    return TOOLS_BY_MODE[mode].includes(name);
  }

  async execute(trx: Transaction<Database>, runtime: ToolRuntime, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'search_knowledge':
        return this.searchKnowledge(trx, args);
      case 'get_practice_info':
        return this.practiceInfo(runtime);
      case 'create_staff_task':
        return this.createTask(trx, runtime, args);
      case 'request_human_handoff':
        return this.handoff(runtime);
      case 'end_conversation':
        // The backend decides: only a caller who has said they are finished can end it, however sure the model is.
        if (!callerIsFinished(runtime.callerText)) {
          return {
            status: 'rejected',
            result: { error: 'The caller has not said they are finished, so the conversation cannot end yet. Answer what they said, or ask if there is anything else you can help with.' },
          };
        }
        runtime.state.ended = true;
        return { status: 'ok', result: { ended: true } };
      default:
        return { status: 'rejected', result: { error: 'Unknown tool' } };
    }
  }

  private async searchKnowledge(trx: Transaction<Database>, args: Record<string, unknown>): Promise<ToolResult> {
    const question = pickString(args, 'question');
    if (!question) {
      return { status: 'rejected', result: { error: 'question is required' } };
    }
    const results = await this.retriever.search(trx, question.slice(0, 500));
    if (results.length === 0) {
      return { status: 'ok', result: { found: false, note: 'No approved information matches. Do not guess: say you do not have that information and offer to take a message.' } };
    }
    return { status: 'ok', result: { found: true, results: results.map(({ title, text }) => ({ title, text })) } };
  }

  private practiceInfo({ context }: ToolRuntime): ToolResult {
    const { practice, config } = context;
    return {
      status: 'ok',
      result: {
        name: practice.name,
        phone: practice.phone,
        timezone: practice.timezone,
        openNow: isOpenAt(config.businessHours, practice.timezone, new Date()),
        // Ready to read out as it is: models (small ones especially) do better with a sentence than with data.
        hoursText: describeBusinessHours(config.businessHours),
        hours: config.businessHours,
        afterHours: config.afterHoursAction === 'transfer' ? 'calls are passed to a person' : 'the AI receptionist takes a message',
      },
    };
  }

  private async createTask(trx: Transaction<Database>, runtime: ToolRuntime, args: Record<string, unknown>): Promise<ToolResult> {
    const created = runtime.tasksBefore + runtime.state.createdTaskIds.length;
    if (created >= MAX_TASKS_PER_CONVERSATION) {
      return { status: 'rejected', result: { error: 'The limit for messages in one conversation has been reached. Tell the caller the team already has their details.' } };
    }
    // A message nobody can answer is useless: the team needs a number to call back. Enforced here, whatever the model decides.
    if (!pickString(args, 'contactPhone')) {
      return {
        status: 'rejected',
        result: { error: 'A phone number is needed so the team can call the caller back. Ask the caller for their name and a phone number (with the country code) first, then try again.' },
      };
    }
    // Only these fields are read; the priority is always normal (urgent tasks come from the safety layer, never from the model).
    const dto = plainToInstance(CreateTaskDto, {
      type: pickString(args, 'type'),
      title: pickString(args, 'title'),
      details: pickString(args, 'details'),
      contactName: pickString(args, 'contactName'),
      contactPhone: pickString(args, 'contactPhone'),
      priority: 'normal',
    });
    const problems = validateSync(dto, { whitelist: true, forbidUnknownValues: true });
    if (problems.length > 0) {
      return { status: 'rejected', result: { error: 'Invalid task', problems: problems.flatMap((problem) => Object.values(problem.constraints ?? {})) } };
    }
    const id = await this.tasks.createInTransaction(trx, runtime.practiceId, dto, { kind: 'ai' }, runtime.meta, runtime.conversationId);
    runtime.state.createdTaskIds.push(id);
    return { status: 'ok', result: { saved: true, taskId: id } };
  }

  private handoff(runtime: ToolRuntime): ToolResult {
    const { context } = runtime;
    const isOpen = isOpenAt(context.config.businessHours, context.practice.timezone, new Date());
    const target = chooseTransferTarget({ config: { ...context.config }, targets: context.targets, isOpen });
    if (target) {
      runtime.state.handoffTargetId = target;
      const label = context.targets.find((candidate) => candidate.id === target)?.label ?? 'our team';
      return { status: 'ok', result: { handedOff: true, to: label } };
    }
    // Nobody to hand over to: the request must not be lost, so the receptionist takes a message instead.
    return {
      status: 'ok',
      result: {
        handedOff: false,
        note: 'No one is available to take the call. Say so, then offer to take a message: ask for their name, a phone number and what it is about, and use create_staff_task.',
      },
    };
  }
}
