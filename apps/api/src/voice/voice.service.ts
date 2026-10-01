import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { aiReadinessProblems, composeGreeting, PHONE_PATTERN } from '@frontdesk/shared';
import { PinoLogger } from 'nestjs-pino';
import { writeAuditLog } from '../audit/audit-log.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { AiService } from '../ai/ai.service.js';
import { LANGUAGE_MODEL, type LanguageModel } from '../agent/model/language-model.js';
import { DB, type Db } from '../database/database.module.js';
import { withPracticeContext } from '../database/practice-context.js';
import { PhoneNumbersService } from './phone-numbers.service.js';
import { RelayTokenService } from './relay-token.js';
import { connectRelayResponse, hangupResponse, sayAndHangupResponse } from './twiml.js';
import type { TwilioParams } from './twilio-signature.js';

/** Twilio's call ids are letters and digits; the database allows up to 64. */
const CALL_SID = /^[A-Za-z0-9]{1,64}$/;
const UNIQUE_VIOLATION = '23505';

/** Said when the dialed number is not one of ours. Reveals nothing about any practice. */
const NOT_IN_SERVICE = sayAndHangupResponse('This number is not in service. Goodbye.');
/** Said when something unexpected went wrong: the caller is never left in silence, and is always told what to do in an emergency. */
const TROUBLE = sayAndHangupResponse(
  'We are sorry, we are unable to take your call right now. If this is a medical emergency, please hang up and call your local emergency number.',
);

export type DeclineReason = 'ai_off' | 'not_ready' | 'no_model';

const single = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === UNIQUE_VIOLATION;

/**
 * Answers the first request of a phone call: which practice is this for, may the AI
 * answer, and if so set up the conversation and tell Twilio to start the voice session.
 *
 * Rules:
 *  - The practice comes ONLY from the dialed number.
 *  - Twilio repeats requests; one call id is one conversation, however many times it is asked.
 *  - Twilio must always get an answer it can act on (a non-success answer makes it play
 *    "application error"), so every path ends in a spoken message or a connected session.
 *  - When the AI cannot answer, the caller hears the practice's own emergency and crisis
 *    messages before the call ends.
 */
@Injectable()
export class VoiceService {
  private readonly relayTokens: RelayTokenService;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModel,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly numbers: PhoneNumbersService,
    private readonly ai: AiService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(VoiceService.name);
    this.relayTokens = new RelayTokenService(this.config.get('ACCESS_TOKEN_SECRET', { infer: true }));
  }

  /** The TwiML answer for an incoming call. Never throws: any failure becomes a spoken message. */
  async handleIncoming(params: TwilioParams): Promise<string> {
    try {
      return await this.incoming(params);
    } catch (error) {
      this.logger.error({ error: error instanceof Error ? error.name : 'unknown' }, 'An incoming call could not be set up');
      return TROUBLE;
    }
  }

  private async incoming(params: TwilioParams): Promise<string> {
    const dialed = single(params['To']);
    const callSid = single(params['CallSid']);
    if (!dialed || !callSid || !CALL_SID.test(callSid)) {
      return NOT_IN_SERVICE;
    }
    const practiceId = await this.numbers.resolvePractice(dialed);
    if (!practiceId) {
      this.logger.info('A call arrived for a number that is not in service');
      return NOT_IN_SERVICE;
    }

    const caller = single(params['From']);
    const callerNumber = caller !== undefined && PHONE_PATTERN.test(caller) ? caller : null;

    // Two requests for the same call can race: one wins the insert, the other then finds the winner's conversation.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withPracticeContext(this.db, { practiceId }, (trx) => this.openOrResume(trx, practiceId, dialed, callSid, callerNumber));
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= 1) throw error;
      }
    }
  }

  private async openOrResume(
    trx: Parameters<Parameters<typeof withPracticeContext>[2]>[0],
    practiceId: string,
    dialed: string,
    callSid: string,
    callerNumber: string | null,
  ): Promise<string> {
    const { settings, targets } = await this.ai.loadForAgent(trx, practiceId);
    const existing = await trx.selectFrom('conversations').select(['id', 'status']).where('provider_call_sid', '=', callSid).executeTakeFirst();
    if (existing) {
      // Twilio asked again about a call we already know. Answer the same way, never create a second conversation.
      return existing.status === 'active' ? this.connect(practiceId, existing.id, composeGreeting(settings.greeting)) : hangupResponse();
    }

    const practice = await trx.selectFrom('practices').select('name').where('id', '=', practiceId).executeTakeFirstOrThrow();
    const reason: DeclineReason | null = !settings.enabled
      ? 'ai_off'
      : aiReadinessProblems(settings, targets).length > 0
        ? 'not_ready'
        : !this.model.configured
          ? 'no_model'
          : null;
    if (reason) {
      await writeAuditLog(trx, {
        practiceId,
        actorUserId: null,
        actorType: 'system',
        action: 'voice.call_declined',
        targetType: 'practice',
        targetId: practiceId,
        metadata: { reason },
      });
      this.logger.warn({ practiceId, reason }, 'A call was not answered by the AI receptionist');
      return sayAndHangupResponse(
        `Thank you for calling ${practice.name}. Our automated assistant is not available right now. Please try again later, or contact the practice directly.`,
        settings.emergencyMessage.trim(),
        settings.crisisMessage.trim(),
      );
    }

    const number = await trx.selectFrom('phone_numbers').select('id').where('e164', '=', dialed).executeTakeFirstOrThrow();
    const greeting = composeGreeting(settings.greeting);
    const { id } = await trx
      .insertInto('conversations')
      .values({
        practice_id: practiceId,
        channel: 'phone',
        provider_call_sid: callSid,
        caller_number: callerNumber,
        phone_number_id: number.id,
        model: this.model.name,
        turn_count: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('conversation_turns')
      .values({ practice_id: practiceId, conversation_id: id, seq: 1, speaker: 'ai', source: 'greeting', text: greeting, guard_reason: null, latency_ms: null })
      .execute();
    await writeAuditLog(trx, {
      practiceId,
      actorUserId: null,
      actorType: 'system',
      action: 'conversation.started',
      targetType: 'conversation',
      targetId: id,
      metadata: { channel: 'phone' },
    });
    this.logger.info({ practiceId, conversationId: id }, 'An incoming call was accepted');
    return this.connect(practiceId, id, greeting);
  }

  /** Tells Twilio to start the voice session, with a one-time address that ties it to this one conversation. */
  private async connect(practiceId: string, conversationId: string, greeting: string): Promise<string> {
    const base = this.config.get('PUBLIC_BASE_URL', { infer: true }) ?? '';
    const token = await this.relayTokens.sign({ conversationId, practiceId });
    return connectRelayResponse({
      relayUrl: `${base.replace(/^http/, 'ws')}/api/voice/relay?token=${token}`,
      actionUrl: `${base}/api/voice/action`,
      greeting,
      ttsProvider: this.config.get('VOICE_TTS_PROVIDER', { infer: true }),
      transcriptionProvider: this.config.get('VOICE_STT_PROVIDER', { infer: true }),
    });
  }
}
