import { Injectable } from '@nestjs/common';
import { describeBusinessHours, isOpenAt, isValidBirthDate, type AiConfiguration, type IdentityCheck, type MessageContact, type TransferTarget } from '@frontdesk/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { sql, type Transaction } from 'kysely';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { KnowledgeRetriever } from '../knowledge/retriever.js';
import { PatientsService } from '../scheduling/patients.service.js';
import { CreateTaskDto } from '../tasks/tasks.dto.js';
import { TasksService } from '../tasks/tasks.service.js';
import type { ModelToolDefinition } from './model/language-model.js';
import type { AgentMode } from './prompt.js';
import { stripControl } from './sanitize.js';
import { callerIsFinished } from './farewell.js';
import { chooseTransferTarget } from './safety/escalation.js';
import { SchedulingTools } from './scheduling-tools.js';
import { callerSaidDate, dateNotSaidMessage } from './spoken-date.js';
import { callerSaidPhone, callerVolunteeredPhone, normalizePhone, PHONE_FORMAT_NOTE, phoneNotSaidMessage } from './spoken-phone.js';

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
  > & { extraUrgentPhrases: string[]; messageContact: MessageContact };
  targets: TransferTarget[];
  /** Whether the practice has switched on booking by the AI receptionist (read by the backend; the model is never told how it is set). */
  scheduling: { enabled: boolean; identityCheck: IdentityCheck };
}

/** The practice settings that decide which tools the model is offered and what they ask it for. */
export interface ToolSettings {
  schedulingEnabled: boolean;
  messageContact: MessageContact;
  identityCheck: IdentityCheck;
}

/** What tools change during one caller turn; applied to the conversation together with the reply. */
export interface TurnState {
  ended: boolean;
  handoffTargetId: string | null;
  createdTaskIds: string[];
  /** Sentences the backend wrote about appointments this turn. When there are any, they are the whole reply and the model's own words are discarded. */
  lines: string[];
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

/** stored, when present, is what is kept in the record of the call instead of esult (for example codes the model must not see). */
export type ToolResult = { status: 'ok' | 'rejected'; result: Record<string, unknown>; stored?: Record<string, unknown> };

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

const PHONE_PROPERTY_ASKED = 'The phone number the caller said, written as a plus sign, the country code, then the number, with no spaces.';

/** The message tool asks for what the practice chose: name and date of birth (the system finds the number), or name and phone number. */
function createStaffTaskTool(messageContact: MessageContact): ModelToolDefinition {
  const byBirthDate = messageContact === 'name_dob';
  return {
    name: 'create_staff_task',
    // With name and birth date this tool asks for the same details as identifying a caller, and a small model then takes it for
    // cancelling or moving an appointment. Saying when it is for (without naming other tools, which draws attention to them) helps.
    description:
      (byBirthDate
        ? 'Pass a message to the practice staff, only when the caller asks to leave a message or needs something you cannot do yourself with your other tools. Ask the caller for their first and last name and date of birth first. Do not ask for a phone number: the system finds the number to call back.'
        : 'Pass a message or callback request to the practice staff. Ask the caller for their name and phone number first.') + ' Returns ok only if it was really saved.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['callback', 'message', 'question', 'other'] },
        title: { type: 'string', description: 'A short summary for staff, for example "Wants an appointment".' },
        details: { type: 'string', description: "What the caller said they need, in the caller's own terms. No medical opinions." },
        contactName: byBirthDate ? { type: 'string', description: "The caller's first and last name." } : { type: 'string' },
        ...(byBirthDate ? { contactDateOfBirth: { type: 'string', description: "The caller's date of birth, written YYYY-MM-DD." } } : {}),
        contactPhone: {
          type: 'string',
          description: byBirthDate ? `Only when the system has asked for a phone number. ${PHONE_PROPERTY_ASKED}` : PHONE_PROPERTY_ASKED,
        },
      },
      required: byBirthDate ? ['type', 'title', 'contactName', 'contactDateOfBirth'] : ['type', 'title', 'contactPhone'],
      additionalProperties: false,
    },
  };
}

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

/** Small models write "null" or "none" for a detail they do not have; that is not a detail. */
const NOT_A_DETAIL = /^(null|none|n\/a|unknown|undefined)$/i;
const pickContact = (args: Record<string, unknown>, key: string): string | undefined => {
  const text = pickString(args, key);
  return text !== undefined && !NOT_A_DETAIL.test(text.trim()) ? text : undefined;
};

/** Who to call back about a message, and (when it was asked for) their date of birth. `note` is what the model is told to say about the number. */
interface Contact {
  phone: string;
  dateOfBirth?: string;
  note?: string;
}

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
    private readonly scheduling: SchedulingTools,
    private readonly patients: PatientsService,
  ) {}

  /** The scheduling tools exist only in a normal conversation, and only while the practice has booking switched on. */
  definitions(mode: AgentMode, { schedulingEnabled, messageContact, identityCheck }: ToolSettings): ModelToolDefinition[] {
    const booking = mode === 'normal' && schedulingEnabled;
    const base = TOOLS_BY_MODE[mode].map((name) => (name === 'create_staff_task' ? createStaffTaskTool(messageContact) : TOOL_DEFINITIONS[name]!));
    return booking ? [...base, ...this.scheduling.definitions(identityCheck)] : base;
  }

  /** What the conversation has already settled about booking (identified or not, the codes issued), for the model's instructions. */
  sessionNotes(trx: Transaction<Database>, conversationId: string): Promise<string> {
    return this.scheduling.notes(trx, conversationId);
  }

  isAllowed(mode: AgentMode, name: string, schedulingEnabled: boolean): boolean {
    if (this.scheduling.handles(name)) return mode === 'normal' && schedulingEnabled;
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
        return this.scheduling.handles(name) ? this.scheduling.execute(trx, runtime, name, args) : { status: 'rejected', result: { error: 'Unknown tool' } };
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
    const contact = await this.resolveContact(trx, runtime, args);
    if ('status' in contact) return contact;

    // Only these fields are read; the priority is always normal (urgent tasks come from the safety layer, never from the model).
    const dto = plainToInstance(CreateTaskDto, {
      type: pickString(args, 'type'),
      title: pickString(args, 'title'),
      details: pickString(args, 'details'),
      contactName: pickContact(args, 'contactName'),
      contactPhone: contact.phone,
      contactDateOfBirth: contact.dateOfBirth,
      priority: 'normal',
    });
    const problems = validateSync(dto, { whitelist: true, forbidUnknownValues: true });
    if (problems.length > 0) {
      const phoneProblem = problems.some((problem) => problem.property === 'contactPhone');
      return {
        status: 'rejected',
        result: {
          error: 'Invalid task',
          problems: problems.flatMap((problem) => Object.values(problem.constraints ?? {})),
          ...(phoneProblem ? { note: PHONE_FORMAT_NOTE } : {}),
        },
      };
    }
    // A model that is told to "save it" again must not make a second task for the same message.
    if (await this.alreadySaved(trx, runtime.conversationId, dto)) {
      return { status: 'ok', result: { saved: true, alreadySaved: true, note: 'This message was already passed on. Do not save it again: tell the caller it has been passed on.' } };
    }
    const id = await this.tasks.createInTransaction(trx, runtime.practiceId, dto, { kind: 'ai' }, runtime.meta, runtime.conversationId);
    runtime.state.createdTaskIds.push(id);
    return { status: 'ok', result: { saved: true, taskId: id, ...(contact.note ? { note: contact.note } : {}) } };
  }

  /**
   * Who to call back, and how they are known. With "name and date of birth" the caller is not asked for a number: it
   * is the one they gave if they chose to, else the number they are calling from, else the number on the patient
   * record with this name and birth date. Only when none exists is the model told to ask for one. With "name and
   * phone number" the caller's number is always needed. A number the caller said is checked against what they said,
   * so a made-up or misheard number never sends staff to call nobody. The number itself is never put in a tool result.
   */
  private async resolveContact(trx: Transaction<Database>, runtime: ToolRuntime, args: Record<string, unknown>): Promise<Contact | ToolResult> {
    const refuse = (error: string): ToolResult => ({ status: 'rejected', result: { error } });
    const said = pickContact(args, 'contactPhone');
    const saidPhone = async (): Promise<Contact | ToolResult> => {
      const phone = normalizePhone(said!); // spaces and dashes are how numbers are said and written, not a mistake
      return (await callerSaidPhone(trx, runtime.conversationId, phone)) ? { phone } : refuse(phoneNotSaidMessage(phone));
    };

    if (runtime.context.config.messageContact === 'name_phone') {
      return said ? saidPhone() : refuse('A phone number is needed so the team can call the caller back. Ask the caller for their name and a phone number (with the country code) first, then try again.');
    }

    const name = pickContact(args, 'contactName');
    const dateOfBirth = pickContact(args, 'contactDateOfBirth');
    if (!name || !dateOfBirth) {
      return refuse("To pass on a message you need the caller's first and last name and date of birth. Ask the caller for what is missing, then try again.");
    }
    if (!isValidBirthDate(dateOfBirth)) {
      return refuse('That date of birth is not a real date. Ask the caller to say it again, and give it to the tool as YYYY-MM-DD.');
    }
    if (!(await callerSaidDate(trx, runtime.conversationId, dateOfBirth))) {
      return refuse(dateNotSaidMessage(dateOfBirth));
    }

    if (said) {
      const given = await saidPhone();
      return 'status' in given ? given : { ...given, dateOfBirth };
    }
    const call = await trx.selectFrom('conversations').select('caller_number').where('id', '=', runtime.conversationId).executeTakeFirstOrThrow();
    if (call.caller_number) {
      return { phone: call.caller_number, dateOfBirth, note: 'Tell the caller the team will call them back on the number they are calling from. Do not say the number.' };
    }
    const patient = await this.patients.findByNameAndBirth(trx, name, dateOfBirth);
    if (patient) {
      return { phone: patient.phone, dateOfBirth, note: 'Tell the caller the team will call them back on the number the practice has on file for them. Do not say the number.' };
    }
    // Last resort before asking: a number the caller already said in full is not asked for again.
    const volunteered = await callerVolunteeredPhone(trx, runtime.conversationId);
    if (volunteered) {
      return { phone: volunteered, dateOfBirth, note: 'Tell the caller the team will call them back on the number they gave. Do not say the number.' };
    }
    return refuse(
      'There is no number to call this caller back on: the call has no caller ID and no patient on file matches that name and date of birth. Ask the caller for a phone number to call back, then try again with contactPhone, written as a plus sign, the country code, then the number.',
    );
  }

  /** Whether this conversation already saved this very message: same kind, same title and same callback number. */
  private async alreadySaved(trx: Transaction<Database>, conversationId: string, dto: CreateTaskDto): Promise<boolean> {
    const row = await trx
      .selectFrom('staff_tasks')
      .select('id')
      .where('conversation_id', '=', conversationId)
      .where('type', '=', dto.type)
      .where('contact_phone', '=', dto.contactPhone ?? '')
      .where(sql<boolean>`lower(btrim(title)) = lower(${dto.title})`)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
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
        note: `No one is available to take the call. Say so, then offer to take a message: ask for their ${
          context.config.messageContact === 'name_dob' ? 'first and last name, date of birth' : 'name, a phone number'
        } and what it is about, and use create_staff_task.`,
      },
    };
  }
}
