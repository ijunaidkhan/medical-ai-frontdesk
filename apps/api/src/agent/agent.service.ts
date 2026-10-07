import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  composeGreeting,
  CRISIS_MESSAGE_MIN_LENGTH,
  EMERGENCY_MESSAGE_MIN_LENGTH,
  isOpenAt,
  type AgentReply,
  type ConversationEscalation,
  type ConversationOutcome,
  type ConversationStatus,
  type StartConversationResponse,
  type TurnSource,
} from '@frontdesk/shared';
import { type Kysely, sql, type Transaction } from 'kysely';
import { PinoLogger } from 'nestjs-pino';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../common/request-meta.js';
import { DB, type Db } from '../database/database.module.js';
import type { Database } from '../database/database.types.js';
import { withPracticeContext } from '../database/practice-context.js';
import { AiService } from '../ai/ai.service.js';
import type { CreateTaskDto } from '../tasks/tasks.dto.js';
import { ANYTHING_ELSE } from '../scheduling/appointment-text.js';
import { SchedulingService } from '../scheduling/scheduling.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { LANGUAGE_MODEL, ModelRequestError, ModelUnavailableError, type LanguageModel, type ModelMessage, type ModelRequest, type ModelResponse } from './model/language-model.js';
import { buildSystemPrompt, type AgentMode } from './prompt.js';
import { jsonSafe, stripControl } from './sanitize.js';
import { classifyUrgency } from './safety/classifier.js';
import { CALLBACK_OFFER, higherEscalation, needsNewTask, planEscalation, SAFETY_NET, URGENT_REPLY_TRANSFER, type EscalationPlan } from './safety/escalation.js';
import { checkReply, SAFE_FALLBACK_REPLY, type GuardVerdict } from './safety/output-guard.js';
import { unsupportedTimes } from './safety/time-check.js';
import { AgentTools, MAX_TOOL_CALLS_PER_TURN, type AgentContext, type ToolRuntime, type TurnState } from './tools.js';

/** A test chat (or call) longer than this many caller messages is ended. */
export const MAX_CALLER_TURNS = 30;
/** How many times in one turn the model may ask for tools before it must answer. */
const MAX_TOOL_ROUNDS = 3;
const MODEL_TIMEOUT_MS = 20_000;
/** How much of the conversation the model is shown. */
const HISTORY_TURNS = 40;

/** Said to the model (never to the caller) when its reply was code or a tool request written out as text. */
export const TOOL_SYNTAX_NOTICE =
  'NOTICE FROM THE SYSTEM, NOT FROM THE CALLER: your last reply could not be used because it contained code or a tool request written out as text. If you need a tool, use the tool mechanism. Otherwise reply again with only plain words for the caller.';

/** Said to the model (never to the caller) when its reply named a time of day that came from nowhere. */
export const UNVERIFIED_TIME_NOTICE =
  'NOTICE FROM THE SYSTEM, NOT FROM THE CALLER: your last reply could not be used because it mentioned a time that no tool gave you. Never make up times. To offer appointment times, call find_available_slots and read out exactly what it returns. Otherwise reply again without any times.';

export const LIMIT_REPLY = 'I am sorry, this conversation has reached its length limit. Please contact the practice directly if you still need help.';

type Executor = Transaction<Database>;

/**
 * Who a conversation is run for. The practice is always known; a signed-in staff
 * member is present only in the text test chat. A phone call has no user at all.
 */
export interface Caller {
  practiceId: string;
  userId?: string;
}

/** The ways a conversation can reach the receptionist. */
export type AgentChannel = 'test_chat' | 'phone';

interface ConversationState {
  status: ConversationStatus;
  escalation: ConversationEscalation | null;
}

/** Everything the first step learns about a message, in one place. */
interface IncomingTurn {
  conversationId: string;
  context: AgentContext;
  conversation: ConversationState;
  history: ModelMessage[];
  callerSeq: number;
  callerTurns: number;
  tasksBefore: number;
  text: string;
  startedAt: number;
  meta: RequestMeta;
  /** What the conversation has already settled about booking, for the model's instructions (empty when booking is off). */
  bookingNotes: string;
}

/**
 * The receptionist's brain, for one channel at a time (the text test chat now;
 * the phone later uses the same steps).
 *
 *   caller message
 *     → safety classifier (code)            emergency/urgent → fixed script, model not involved
 *     → model + tools (backend validates)   every tool call checked and recorded
 *     → reply checker (code)                unsafe reply → fixed safe line
 *     → stored transcript
 *
 * The practice always comes from the stored conversation, never from the model.
 * No database transaction is held open while the model thinks.
 */
@Injectable()
export class AgentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModel,
    private readonly tools: AgentTools,
    private readonly tasks: TasksService,
    private readonly ai: AiService,
    private readonly scheduling: SchedulingService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AgentService.name);
  }

  // ------------------------------------------------------------------ start

  async startTestConversation(auth: AuthContext, meta: RequestMeta): Promise<StartConversationResponse> {
    if (!this.model.configured) {
      throw new ServiceUnavailableException('The AI model is not set up yet. Ask the system administrator to configure it.');
    }
    return this.inPractice(auth.practiceId, auth.userId, async (trx) => {
      const { context } = await this.loadContext(trx, auth.practiceId);
      const problems: string[] = [];
      if (context.config.greeting.trim().length === 0) problems.push('Write a greeting');
      if (context.config.emergencyMessage.trim().length < EMERGENCY_MESSAGE_MIN_LENGTH) {
        problems.push('Write the emergency message callers will hear (who to call in a medical emergency)');
      }
      if (context.config.crisisMessage.trim().length < CRISIS_MESSAGE_MIN_LENGTH) {
        problems.push('Write the crisis message callers will hear if they mention suicide or self-harm (for example, the 988 line in the US)');
      }
      if (problems.length > 0) {
        throw new ConflictException(problems);
      }

      const greeting = composeGreeting(context.config.greeting);
      const { id } = await trx
        .insertInto('conversations')
        .values({ practice_id: auth.practiceId, channel: 'test_chat', started_by: auth.userId, model: this.model.name, turn_count: 1 })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.insertTurn(trx, auth.practiceId, id, 1, 'ai', 'greeting', greeting, null, null);
      await writeAuditLog(trx, {
        practiceId: auth.practiceId,
        actorUserId: auth.userId,
        action: 'conversation.started',
        targetType: 'conversation',
        targetId: id,
        requestId: meta.requestId,
        ip: meta.ip,
        metadata: { channel: 'test_chat' },
      });
      return { conversationId: id, greeting };
    });
  }

  // ---------------------------------------------------------------- message

  /** One message in the staff test chat. */
  sendMessage(auth: AuthContext, conversationId: string, text: string, meta: RequestMeta): Promise<AgentReply> {
    return this.converse(auth, 'test_chat', conversationId, text, meta);
  }

  /**
   * What a caller said on the phone (already turned into text). The practice and the
   * conversation come from the stored call; there is no signed-in user.
   */
  answerCall(practiceId: string, conversationId: string, text: string, meta: RequestMeta): Promise<AgentReply> {
    return this.converse({ practiceId }, 'phone', conversationId, text, meta);
  }

  private async converse(auth: Caller, channel: AgentChannel, conversationId: string, text: string, meta: RequestMeta): Promise<AgentReply> {
    const turn = await this.receive(auth, channel, conversationId, text, meta);
    const { context, conversation } = turn;

    const isOpen = isOpenAt(context.config.businessHours, context.practice.timezone, new Date());
    const classification = classifyUrgency(text, context.config.extraUrgentPhrases);
    const plan = planEscalation(classification, { config: context.config, targets: context.targets, isOpen });

    // 1. A new emergency or urgent request is answered by the fixed script. The model is not asked.
    if (plan.kind !== 'none' && needsNewTask(conversation.escalation, plan.kind)) {
      return this.escalate(auth, turn, plan);
    }
    // 2. Too long a conversation ends (an emergency above still gets through).
    if (turn.callerTurns > MAX_CALLER_TURNS) {
      return this.endForLimit(auth, turn);
    }
    // 3. Otherwise the model answers. Once escalated it may only take a callback request, and a repeated
    //    emergency phrase gets the practice's emergency message added to whatever the model says.
    const mode: AgentMode = conversation.escalation === null ? 'normal' : 'message_only';
    const repeatedNotice = plan.kind === 'none' ? '' : plan.notice;
    return this.answerWithModel(auth, channel, turn, mode, repeatedNotice);
  }

  // -------------------------------------------------------- step 1: receive

  /** Records the caller's message and gathers what the next steps need. Short transaction, no model call. */
  private receive(auth: Caller, channel: AgentChannel, conversationId: string, text: string, meta: RequestMeta): Promise<IncomingTurn> {
    const startedAt = Date.now();
    return this.inPractice(auth.practiceId, auth.userId, async (trx) => {
      const row = await trx.selectFrom('conversations').selectAll().where('id', '=', conversationId).forUpdate().executeTakeFirst();
      // A phone conversation can only be continued by the phone channel and a test chat only by the test chat.
      if (!row || row.channel !== channel) {
        throw new NotFoundException('Conversation not found');
      }
      if (row.status !== 'active') {
        throw new ConflictException('This conversation has ended. Start a new one.');
      }

      const { context } = await this.loadContext(trx, auth.practiceId);
      const recent = await trx
        .selectFrom('conversation_turns')
        .select(['seq', 'speaker', 'text'])
        .where('conversation_id', '=', conversationId)
        .orderBy('seq', 'desc')
        .limit(HISTORY_TURNS)
        .execute();
      const callerSeq = (recent[0]?.seq ?? 0) + 1;
      const counts = await trx
        .selectFrom('conversation_turns')
        .select((eb) => eb.fn.countAll<string>().as('callers'))
        .where('conversation_id', '=', conversationId)
        .where('speaker', '=', 'caller')
        .executeTakeFirstOrThrow();
      const tasks = await trx
        .selectFrom('staff_tasks')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .where('conversation_id', '=', conversationId)
        .where('created_by_type', '=', 'ai')
        .where('priority', '=', 'normal')
        .executeTakeFirstOrThrow();

      await this.insertTurn(trx, auth.practiceId, conversationId, callerSeq, 'caller', 'caller', text, null, null);
      await trx.updateTable('conversations').set({ turn_count: sql`turn_count + 1` }).where('id', '=', conversationId).execute();

      const history: ModelMessage[] = recent
        .reverse()
        .filter((turn) => turn.speaker !== 'system')
        .map((turn) => (turn.speaker === 'caller' ? { role: 'user', text: turn.text } : { role: 'assistant', text: turn.text }));

      const bookingNotes = context.scheduling.enabled && row.escalation === null ? await this.tools.sessionNotes(trx, conversationId) : '';
      return {
        conversationId,
        context,
        conversation: { status: row.status, escalation: row.escalation },
        history,
        callerSeq,
        callerTurns: Number(counts.callers) + 1,
        tasksBefore: Number(tasks.total),
        text,
        startedAt,
        meta,
        bookingNotes,
      };
    });
  }

  // ------------------------------------------------ path 1: fixed safety script

  private escalate(auth: Caller, turn: IncomingTurn, plan: Exclude<EscalationPlan, { kind: 'none' }>): Promise<AgentReply> {
    const { conversationId, meta } = turn;
    return this.inPractice(auth.practiceId, auth.userId, async (trx) => {
      const row = await this.lockActive(trx, conversationId);
      const createdTaskIds: string[] = [];

      // Staff are told straight away. Urgent priority is set here, in code, never by a model.
      if (plan.createTask && needsNewTask(row.escalation, plan.kind)) {
        const task: CreateTaskDto = {
          type: 'callback',
          priority: 'urgent',
          title: plan.kind === 'emergency' ? 'Possible medical emergency: caller was given the emergency message' : 'Urgent call: please contact the caller as soon as possible',
          details: `Raised automatically by the receptionist's safety rules (matched: ${plan.matches.join(', ')}). Read the conversation to see what the caller said.`.slice(0, 1_000),
        };
        createdTaskIds.push(await this.tasks.createInTransaction(trx, auth.practiceId, task, { kind: 'ai' }, meta, conversationId));
      }

      // With a person to hand the call to, the AI stops here. Without one it stays on, to take a callback request.
      const handoff = plan.transferTargetId !== null;
      const reply = handoff ? plan.reply : `${plan.reply} ${CALLBACK_OFFER}`;
      const source: TurnSource = plan.kind === 'emergency' ? 'scripted_emergency' : 'scripted_urgent';
      const escalation = higherEscalation(row.escalation, plan.kind);
      const saved = await this.appendAiTurn(trx, auth.practiceId, conversationId, source, reply, null, Date.now() - turn.startedAt);
      const after = await this.updateConversation(trx, conversationId, {
        escalation,
        ...(handoff ? { status: 'handed_off' as const, outcome: escalation === 'emergency' ? ('emergency' as const) : ('handed_off' as const), handoff_target_id: plan.transferTargetId, ended_at: sql<Date>`now()` } : {}),
      });

      await writeAuditLog(trx, {
        practiceId: auth.practiceId,
        actorUserId: null,
        actorType: 'system',
        action: 'conversation.escalated',
        targetType: 'conversation',
        targetId: conversationId,
        requestId: meta.requestId,
        ip: meta.ip,
        // Level and what happened; never the caller's words.
        metadata: { level: plan.kind, taskCreated: createdTaskIds.length > 0, handedOff: handoff, turn: saved },
      });
      return this.toReply(conversationId, reply, source, after, createdTaskIds);
    });
  }

  private endForLimit(auth: Caller, turn: IncomingTurn): Promise<AgentReply> {
    const { conversationId, context } = turn;
    const emergencyMessage = context.config.emergencyMessage.trim();
    const reply = emergencyMessage ? `${LIMIT_REPLY} ${SAFETY_NET} ${emergencyMessage}` : LIMIT_REPLY;
    return this.inPractice(auth.practiceId, auth.userId, async (trx) => {
      const row = await this.lockActive(trx, conversationId);
      await this.appendAiTurn(trx, auth.practiceId, conversationId, 'scripted_limit', reply, null, Date.now() - turn.startedAt);
      const after = await this.updateConversation(trx, conversationId, {
        status: 'completed',
        outcome: this.outcomeOnEnd(row.escalation, turn.tasksBefore),
        ended_at: sql<Date>`now()`,
      });
      return this.toReply(conversationId, reply, 'scripted_limit', after, []);
    });
  }

  // ----------------------------------------------------- path 2: the model

  private async answerWithModel(auth: Caller, channel: AgentChannel, turn: IncomingTurn, mode: AgentMode, fixedSuffix: string): Promise<AgentReply> {
    const { conversationId, context, meta } = turn;
    const state: TurnState = { ended: false, handoffTargetId: null, createdTaskIds: [], lines: [] };
    const runtime: ToolRuntime = { practiceId: auth.practiceId, conversationId, context, meta, state, tasksBefore: turn.tasksBefore, callerText: turn.text };
    const isOpen = isOpenAt(context.config.businessHours, context.practice.timezone, new Date());
    const system = buildSystemPrompt({ practiceName: context.practice.name, isOpen, mode, channel, scheduling: context.scheduling.enabled, bookingNotes: turn.bookingNotes });
    const messages: ModelMessage[] = [...turn.history, { role: 'user', text: turn.text }];

    let draft = '';
    let failure: string | null = null;
    let toolCalls = 0;
    /** Lets the model use tools for up to a few rounds and returns what it finally says. */
    const runRounds = async (): Promise<string> => {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        // On the last round no tools are offered, so the model has to answer in words.
        const response = await this.ask({ system, messages, tools: round === MAX_TOOL_ROUNDS ? [] : this.tools.definitions(mode, context.scheduling.enabled) });
        if (response.toolCalls.length === 0) {
          return response.text;
        }
        messages.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls });
        for (const call of response.toolCalls) {
          toolCalls += 1;
          const refused = toolCalls > MAX_TOOL_CALLS_PER_TURN || !this.tools.isAllowed(mode, call.name, context.scheduling.enabled);
          const outcome = refused
            ? { status: 'rejected' as const, result: { error: 'That tool is not available right now' } }
            : await this.runTool(auth, runtime, turn.callerSeq, call.name, call.arguments);
          if (refused) {
            await this.recordInvocationAlone(auth, conversationId, turn.callerSeq, call.name, call.arguments, outcome.result, 'rejected', 0);
          }
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(outcome.result) });
        }
        // The backend has written what the caller must hear (a booking, a cancellation...): the model is not asked again.
        if (state.lines.length > 0) {
          return '';
        }
      }
      return '';
    };
    /**
     * The reply checks, plus one that needs this turn's context: every time of day in the reply must come from
     * a tool result, what the backend has settled in the conversation, or the caller's own words (never from the
     * model's earlier lines, which may themselves be made up).
     */
    const check = (text: string): GuardVerdict => {
      const verdict = checkReply(text);
      if (!verdict.ok) return verdict;
      const sources = [turn.bookingNotes, ...messages.map((message) => (message.role === 'tool' ? message.content : message.role === 'user' ? message.text : ''))].join('\n');
      return unsupportedTimes(text, sources).length > 0 ? { ok: false, reason: 'unverified_time' } : verdict;
    };
    try {
      draft = await runRounds();
      // A model that writes tool syntax or code instead of words, or says a time it was never given, gets ONE more
      // chance, told what was wrong, before the caller is given the fixed safe line. Every other kind of blocked
      // reply (an invented diagnosis, a false booking claim...) is never retried.
      const first = state.lines.length > 0 ? ({ ok: true } as const) : check(stripControl(draft).trim());
      if (!first.ok && (first.reason === 'tool_syntax' || first.reason === 'unverified_time')) {
        messages.push({ role: 'assistant', text: draft }, { role: 'user', text: first.reason === 'tool_syntax' ? TOOL_SYNTAX_NOTICE : UNVERIFIED_TIME_NOTICE });
        draft = await runRounds();
      }
    } catch (error) {
      failure = error instanceof ModelUnavailableError ? 'model_unavailable' : 'model_error';
      // Only our own error types carry a message written to be safe to log (a status number, never vendor text).
      const safeDetail = error instanceof ModelUnavailableError || error instanceof ModelRequestError ? error.message : undefined;
      this.logger.warn(
        { conversationId, practiceId: auth.practiceId, error: error instanceof Error ? error.name : 'unknown', detail: safeDetail },
        'The language model failed; using the safe reply',
      );
    }

    // Every reply is checked on its way out. A failed or unsafe one is replaced by a fixed line.
    const cleaned = stripControl(draft).trim();
    // When the backend wrote what the caller must hear, that is the whole reply: it states facts about real appointments,
    // so the model's words for the turn are dropped and nothing in them can contradict it.
    const backendReply = state.lines.length > 0 ? `${state.lines.join(' ')} ${ANYTHING_ELSE}` : null;
    const verdict = backendReply !== null ? ({ ok: true } as const) : failure === null ? check(cleaned) : ({ ok: false, reason: failure } as const);
    const replaced = !verdict.ok;
    let reply: string;
    if (backendReply !== null) {
      reply = backendReply;
    } else if (!replaced) {
      reply = cleaned;
    } else if (state.handoffTargetId !== null) {
      reply = URGENT_REPLY_TRANSFER; // the hand-over happened; say only that
    } else {
      reply = SAFE_FALLBACK_REPLY;
    }
    if (fixedSuffix) {
      reply = `${reply} ${fixedSuffix}`;
    }
    const source: TurnSource = backendReply !== null ? 'scripted_booking' : replaced ? 'scripted_guard' : 'model';
    const guardReason = verdict.ok ? null : verdict.reason;
    // What the model wrote is kept for reviewers when the safety check replaced it (not when the model simply failed).
    const blockedText = !verdict.ok && failure === null && cleaned !== '' ? cleaned.slice(0, 4_000) : null;
    // (A turn the backend answered keeps the model's discarded words out of the transcript: only what the caller heard is stored.)

    return this.inPractice(auth.practiceId, auth.userId, async (trx) => {
      const row = await this.lockActive(trx, conversationId);
      const escalation = row.escalation;
      await this.appendAiTurn(trx, auth.practiceId, conversationId, source, reply, guardReason, Date.now() - turn.startedAt, blockedText);

      let changes: Parameters<typeof this.updateConversation>[2] = {};
      if (state.handoffTargetId !== null) {
        changes = {
          status: 'handed_off',
          outcome: escalation === 'emergency' ? 'emergency' : 'handed_off',
          handoff_target_id: state.handoffTargetId,
          ended_at: sql<Date>`now()`,
        };
      } else if (state.ended) {
        changes = {
          status: 'completed',
          outcome: this.outcomeOnEnd(escalation, turn.tasksBefore + state.createdTaskIds.length),
          ended_at: sql<Date>`now()`,
        };
      }
      const after = await this.updateConversation(trx, conversationId, changes);
      if (state.handoffTargetId !== null) {
        await writeAuditLog(trx, {
          practiceId: auth.practiceId,
          actorUserId: null,
          actorType: 'system',
          action: 'conversation.handed_off',
          targetType: 'conversation',
          targetId: conversationId,
          requestId: meta.requestId,
          ip: meta.ip,
          metadata: { targetId: state.handoffTargetId },
        });
      }
      return this.toReply(conversationId, reply, source, after, state.createdTaskIds);
    });
  }

  // ------------------------------------------------------------------ tools

  /**
   * Runs one tool in its own short transaction, together with the record of it.
   * If the tool fails, the transaction rolls back (so nothing half-done is kept),
   * the turn state is restored, and the failure is recorded separately.
   */
  private async runTool(
    auth: Caller,
    runtime: ToolRuntime,
    turnSeq: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ status: 'ok' | 'rejected' | 'error'; result: Record<string, unknown> }> {
    const before = structuredClone(runtime.state);
    const started = Date.now();
    try {
      return await this.inPractice(auth.practiceId, auth.userId, async (trx) => {
        const outcome = await this.tools.execute(trx, runtime, name, args);
        await this.recordInvocation(trx, runtime.practiceId, runtime.conversationId, turnSeq, name, args, outcome.stored ?? outcome.result, outcome.status, Date.now() - started);
        return outcome;
      });
    } catch (error) {
      Object.assign(runtime.state, before);
      runtime.state.createdTaskIds = before.createdTaskIds;
      this.logger.error(
        { conversationId: runtime.conversationId, practiceId: runtime.practiceId, tool: name, error: error instanceof Error ? error.message : 'unknown' },
        'A receptionist tool failed',
      );
      const result = { error: 'The tool failed and nothing was saved. Do not try again; offer another way to help.' };
      await this.recordInvocationAlone(auth, runtime.conversationId, turnSeq, name, args, result, 'error', Date.now() - started).catch(() => undefined);
      return { status: 'error', result };
    }
  }

  /** Stores what the model asked for and what the backend answered, inside the given transaction. */
  private recordInvocation(
    trx: Kysely<Database>,
    practiceId: string,
    conversationId: string,
    turnSeq: number,
    tool: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
    status: 'ok' | 'rejected' | 'error',
    durationMs: number,
  ) {
    return trx
      .insertInto('tool_invocations')
      .values({
        practice_id: practiceId,
        conversation_id: conversationId,
        turn_seq: turnSeq,
        tool_name: tool.slice(0, 64),
        arguments: jsonSafe(args),
        result: jsonSafe(result),
        status,
        duration_ms: durationMs,
      })
      .execute();
  }

  /** The same, in its own transaction (for refusals and failures, which have no transaction of their own). */
  private recordInvocationAlone(
    auth: Caller,
    conversationId: string,
    turnSeq: number,
    tool: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
    status: 'rejected' | 'error',
    durationMs: number,
  ) {
    return this.inPractice(auth.practiceId, auth.userId, (trx) =>
      this.recordInvocation(trx, auth.practiceId, conversationId, turnSeq, tool, args, result, status, durationMs),
    );
  }

  // ---------------------------------------------------------------- helpers

  private async ask(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.model.timeoutMs ?? MODEL_TIMEOUT_MS);
    try {
      return await Promise.race([
        this.model.complete(request, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new ModelUnavailableError('The language model timed out')))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every tenant query runs with the practice set for row-level security. The practice is always the stored conversation's. */
  private inPractice<T>(practiceId: string, userId: string | undefined, work: (trx: Executor) => Promise<T>): Promise<T> {
    return withPracticeContext(this.db, userId === undefined ? { practiceId } : { practiceId, userId }, work);
  }

  private async loadContext(trx: Executor, practiceId: string): Promise<{ context: AgentContext }> {
    const practice = await trx.selectFrom('practices').select(['name', 'phone', 'timezone']).where('id', '=', practiceId).executeTakeFirstOrThrow();
    const { settings, targets } = await this.ai.loadForAgent(trx, practiceId);
    const scheduling = await this.scheduling.loadSettings(trx, practiceId);
    return {
      context: {
        practice,
        targets,
        scheduling: { enabled: scheduling.aiBookingEnabled },
        config: {
          greeting: settings.greeting,
          emergencyMessage: settings.emergencyMessage,
          crisisMessage: settings.crisisMessage,
          urgentAction: settings.urgentAction,
          urgentTransferTargetId: settings.urgentTransferTargetId,
          afterHoursAction: settings.afterHoursAction,
          afterHoursTransferTargetId: settings.afterHoursTransferTargetId,
          businessHours: settings.businessHours,
          extraUrgentPhrases: settings.extraUrgentPhrases,
        },
      },
    };
  }

  /** The conversation row, locked, and still active (it may have ended while the model was thinking). */
  private async lockActive(trx: Executor, conversationId: string) {
    const row = await trx.selectFrom('conversations').selectAll().where('id', '=', conversationId).forUpdate().executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Conversation not found');
    }
    if (row.status !== 'active') {
      throw new ConflictException('This conversation has ended. Start a new one.');
    }
    return row;
  }

  private outcomeOnEnd(escalation: ConversationEscalation | null, tasksCreated: number): ConversationOutcome {
    if (escalation === 'emergency') return 'emergency';
    return tasksCreated > 0 ? 'message_taken' : 'answered';
  }

  private insertTurn(
    trx: Executor,
    practiceId: string,
    conversationId: string,
    seq: number,
    speaker: 'caller' | 'ai',
    source: TurnSource,
    text: string,
    guardReason: string | null,
    latencyMs: number | null,
    blockedText: string | null = null,
  ) {
    return trx
      .insertInto('conversation_turns')
      .values({
        practice_id: practiceId,
        conversation_id: conversationId,
        seq,
        speaker,
        source,
        text,
        guard_reason: guardReason,
        blocked_text: blockedText,
        latency_ms: latencyMs,
      })
      .execute();
  }

  /** Adds the AI's line after the last one; returns its position. */
  private async appendAiTurn(
    trx: Executor,
    practiceId: string,
    conversationId: string,
    source: TurnSource,
    text: string,
    guardReason: string | null,
    latencyMs: number,
    blockedText: string | null = null,
  ): Promise<number> {
    const last = await trx
      .selectFrom('conversation_turns')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .where('conversation_id', '=', conversationId)
      .executeTakeFirstOrThrow();
    const seq = (last.seq ?? 0) + 1;
    await this.insertTurn(trx, practiceId, conversationId, seq, 'ai', source, text, guardReason, latencyMs, blockedText);
    return seq;
  }

  private async updateConversation(
    trx: Executor,
    conversationId: string,
    changes: {
      status?: ConversationStatus;
      outcome?: ConversationOutcome;
      escalation?: ConversationEscalation;
      handoff_target_id?: string | null;
      ended_at?: ReturnType<typeof sql<Date>>;
    },
  ): Promise<{ status: ConversationStatus; outcome: ConversationOutcome | null; escalation: ConversationEscalation | null }> {
    return trx
      .updateTable('conversations')
      .set({ ...changes, turn_count: sql`turn_count + 1`, model: this.model.name })
      .where('id', '=', conversationId)
      .returning(['status', 'outcome', 'escalation'])
      .executeTakeFirstOrThrow();
  }

  private toReply(
    conversationId: string,
    reply: string,
    source: TurnSource,
    after: { status: ConversationStatus; outcome: ConversationOutcome | null; escalation: ConversationEscalation | null },
    createdTaskIds: string[],
  ): AgentReply {
    return { conversationId, reply, status: after.status, outcome: after.outcome, escalation: after.escalation, source, createdTaskIds };
  }
}
