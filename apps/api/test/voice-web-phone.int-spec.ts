import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WEEKDAYS, type AiSettings, type ConversationDetail, type Role, type StartWebCallResponse } from '@frontdesk/shared';
import request from 'supertest';
import type WebSocket from 'ws';
import { callTool, say, ScriptedModel, type ScriptedStep } from '../src/agent/model/scripted-model.js';
import { CALLBACK_OFFER, EMERGENCY_REPLY_ALERT } from '../src/agent/safety/escalation.js';
import type { Db } from '../src/database/database.module.js';
import { RelayTokenService } from '../src/voice/relay-token.js';
import { expectedTwilioSignature } from '../src/voice/twilio-signature.js';
import { startTestApp } from './support/app.js';
import { as, signIn, uniqueIp, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';
import { openVoiceClient, refusedWith, until, type VoiceClient } from './support/voice-client.js';

// The web phone is switched on for this file only (each test file runs in its own process).
process.env['VOICE_PROVIDER'] = 'dev';

const ALL_DAY = Object.fromEntries(WEEKDAYS.map((day) => [day, [{ open: '00:00', close: '24:00' }]]));
const EMERGENCY = 'If this is a medical emergency, hang up and call 911 now.';
const CRISIS = 'If you are thinking about suicide, call or text 988 now.';
const SETTINGS = { greeting: 'Thank you for calling Clinic.', emergencyMessage: EMERGENCY, crisisMessage: CRISIS, businessHours: ALL_DAY };

describe('the web phone (VOICE_PROVIDER=dev)', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let port: number;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  let gamma: SeededPractice;
  const token: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  let betaToken: string;
  let gammaToken: string;
  const queue: ScriptedStep[] = [];
  const model = new ScriptedModel((req) => {
    const next = queue.shift();
    if (next) return next;
    const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
    return say(`Echo: ${lastUser?.role === 'user' ? lastUser.text : ''}`);
  });
  const script = (...steps: ScriptedStep[]) => queue.push(...steps);
  const relayTokens = new RelayTokenService(process.env['ACCESS_TOKEN_SECRET'] ?? '');
  const opened: WebSocket[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    gamma = await seedPractice(owner, 'gamma');
    await addMember(owner, alpha.practiceId, 'admin@alpha.test', 'admin');
    await addMember(owner, alpha.practiceId, 'staff@alpha.test', 'staff');
    await addMember(owner, alpha.practiceId, 'viewer@alpha.test', 'viewer');
    app = await startTestApp({ model });
    await app.listen(0, '127.0.0.1'); // a real listening server, so real WebSocket clients can connect
    port = ((app.getHttpServer() as unknown as Server).address() as AddressInfo).port;
    token.owner = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    token.admin = (await signIn(app, { email: 'admin@alpha.test' })).session.accessToken;
    token.staff = (await signIn(app, { email: 'staff@alpha.test' })).session.accessToken;
    token.viewer = (await signIn(app, { email: 'viewer@alpha.test' })).session.accessToken;
    betaToken = (await signIn(app, { email: beta.ownerEmail })).session.accessToken;
    gammaToken = (await signIn(app, { email: gamma.ownerEmail })).session.accessToken;
    // Alpha and beta have written their greeting and safety messages; the AI is NOT switched on in either. Gamma has written nothing.
    await as(app, token.admin).patch('/api/ai/settings', SETTINGS).expect(200);
    await as(app, betaToken).patch('/api/ai/settings', SETTINGS).expect(200);
  });

  beforeEach(() => {
    queue.length = 0;
    model.requests.length = 0;
  });

  afterEach(() => {
    for (const ws of opened.splice(0)) ws.terminate();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  // -------------------------------------------------------------- helpers

  const startCall = async (t = token.admin) => (await as(app, t).post('/api/voice/web-calls').expect(201)).body as StartWebCallResponse;
  /** Opens the voice session the way the browser does: to the address it was given, with nothing signed. */
  const openSession = (sessionPath: string) => openVoiceClient(`ws://127.0.0.1:${port}${sessionPath}`, opened);
  const setup = (client: VoiceClient, callSid: string) => client.ws.send(JSON.stringify({ type: 'setup', callSid }));
  const prompt = (client: VoiceClient, text: string) => client.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: text, last: true }));
  const messageOfType = (client: VoiceClient, type: string) => client.received.find((message) => message['type'] === type);
  const conversation = (id: string) => owner.selectFrom('conversations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const turns = (id: string) => owner.selectFrom('conversation_turns').select(['seq', 'speaker', 'source', 'text']).where('conversation_id', '=', id).orderBy('seq').execute();

  // -------------------------------------------------------------- starting a call

  describe('starting a call', () => {
    it.each<[Role, number]>([['owner', 201], ['admin', 201], ['staff', 403], ['viewer', 403]])('as %s -> %i', async (role, status) => {
      await as(app, token[role]).post('/api/voice/web-calls').expect(status);
    });

    it('needs a login', async () => {
      await request(app.getHttpServer()).post('/api/voice/web-calls').set('X-Forwarded-For', uniqueIp()).expect(401);
    });

    it('can be tried before the AI is switched on, like the test chat', async () => {
      expect(((await as(app, token.admin).get('/api/ai/settings').expect(200)).body as AiSettings).enabled).toBe(false);
      await startCall();
    });

    it('is refused, with the reasons, until the greeting and both safety messages are written', async () => {
      const refused = await as(app, gammaToken).post('/api/voice/web-calls').expect(409);
      expect((refused.body as { message: string[] }).message).toHaveLength(3);
    });

    it('makes a phone conversation for the staff member, with no real number behind it, and audits it', async () => {
      const call = await startCall(token.admin);
      expect(call.callSid).toMatch(/^WEB[0-9a-f]{32}$/);
      expect(call.sessionPath).toMatch(/^\/api\/voice\/relay\?token=[\w.-]+$/);
      expect(call.greeting).toContain('Thank you for calling Clinic.');

      expect(await conversation(call.conversationId)).toMatchObject({
        practice_id: alpha.practiceId,
        channel: 'phone',
        status: 'active',
        provider_call_sid: call.callSid,
        caller_number: null,
        phone_number_id: null,
      });
      expect((await conversation(call.conversationId)).started_by).not.toBeNull();
      expect(await turns(call.conversationId)).toMatchObject([{ seq: 1, speaker: 'ai', source: 'greeting', text: call.greeting }]);
      const entries = await owner.selectFrom('audit_logs').selectAll().where('action', '=', 'conversation.started').where('target_id', '=', call.conversationId).execute();
      expect(entries).toMatchObject([{ actor_type: 'user', metadata: { channel: 'phone' } }]);
      expect(entries[0]!.actor_user_id).not.toBeNull();
    });

    it('each call gets its own id and its own session address', async () => {
      const [first, second] = [await startCall(), await startCall()];
      expect(first.callSid).not.toBe(second.callSid);
      expect(first.sessionPath).not.toBe(second.sessionPath);
    });

    it('the Twilio routes stay switched off', async () => {
      const params = { CallSid: 'CA00000000000000000000000000000001', From: '+16505550199', To: '+14155550101' };
      await request(app.getHttpServer()).post('/api/voice/incoming').set('X-Forwarded-For', uniqueIp()).set('X-Twilio-Signature', expectedTwilioSignature('x'.repeat(32), 'http://x/api/voice/incoming', params)).type('form').send(params).expect(404);
    });
  });

  // -------------------------------------------------------------- the handshake

  describe('the voice session handshake', () => {
    it('opens with the address given for the call, with nothing signed', async () => {
      const call = await startCall();
      expect(await refusedWith(openSession(call.sessionPath))).toBe('opened');
    });

    it('with no token, a wrong token, or an expired token: 401', async () => {
      const call = await startCall();
      expect(await refusedWith(openSession('/api/voice/relay'))).toBe(401);
      expect(await refusedWith(openSession('/api/voice/relay?token=not.a.token'))).toBe(401);
      const expired = await relayTokens.sign({ conversationId: call.conversationId, practiceId: alpha.practiceId }, new Date(Date.now() - 10 * 60_000));
      expect(await refusedWith(openSession(`/api/voice/relay?token=${expired}`))).toBe(401);
    });

    it('only one session per call: a second attempt is refused (409), even after the first has closed', async () => {
      const call = await startCall();
      const first = await openSession(call.sessionPath);
      expect(await refusedWith(openSession(call.sessionPath))).toBe(409);
      first.ws.close();
      await first.closed;
      expect(await refusedWith(openSession(call.sessionPath))).toBe(409);
    });

    it('a call that has ended cannot be joined (410)', async () => {
      const call = await startCall();
      await owner.updateTable('conversations').set({ status: 'completed', outcome: 'answered', ended_at: new Date() }).where('id', '=', call.conversationId).execute();
      expect(await refusedWith(openSession(call.sessionPath))).toBe(410);
    });

    it('another practice’s call cannot be reached, even with a token that names it (410)', async () => {
      const betaCall = await startCall(betaToken);
      const forged = await relayTokens.sign({ conversationId: betaCall.conversationId, practiceId: alpha.practiceId });
      expect(await refusedWith(openSession(`/api/voice/relay?token=${forged}`))).toBe(410);
      expect(model.requests).toHaveLength(0);
    });

    it('a test chat is not a call (410)', async () => {
      const chat = (await as(app, token.admin).post('/api/agent/test-conversations').expect(201)).body as { conversationId: string };
      const forged = await relayTokens.sign({ conversationId: chat.conversationId, practiceId: alpha.practiceId });
      expect(await refusedWith(openSession(`/api/voice/relay?token=${forged}`))).toBe(410);
    });

    it('a real phone call is refused without Twilio’s signature, whatever token it carries (403)', async () => {
      const [real] = await owner
        .insertInto('conversations')
        .values({ practice_id: alpha.practiceId, channel: 'phone', provider_call_sid: 'CA00000000000000000000000000000002', turn_count: 0 })
        .returning('id')
        .execute();
      const genuine = await relayTokens.sign({ conversationId: real!.id, practiceId: alpha.practiceId });
      expect(await refusedWith(openSession(`/api/voice/relay?token=${genuine}`))).toBe(403);
    });

    it('a web-phone call cannot be driven through the text chat (404)', async () => {
      const call = await startCall();
      await as(app, token.admin).post(`/api/agent/test-conversations/${call.conversationId}/messages`, { text: 'hello' }).expect(404);
    });
  });

  // -------------------------------------------------------------- a call

  describe('a call, with the browser playing the phone', () => {
    it('answers what the caller says as a phone call, stores both sides, and closes out the call on hang-up', async () => {
      const call = await startCall();
      script(callTool('get_practice_info', {}), say('We are open every day, all day.'));
      const client = await openSession(call.sessionPath);
      setup(client, call.callSid);
      prompt(client, 'What are your hours?');
      await until(() => messageOfType(client, 'text') !== undefined, 'the reply');

      expect(messageOfType(client, 'text')).toEqual({ type: 'text', token: 'We are open every day, all day.', last: true, interruptible: true });
      expect((await turns(call.conversationId)).map((turn) => [turn.speaker, turn.source, turn.text])).toEqual([
        ['ai', 'greeting', call.greeting],
        ['caller', 'caller', 'What are your hours?'],
        ['ai', 'model', 'We are open every day, all day.'],
      ]);
      expect(model.requests[0]!.system).toContain('This is a live PHONE CALL'); // spoken words, short replies

      client.ws.close(); // hang up
      await until(async () => (await conversation(call.conversationId)).status === 'completed', 'the call to be closed out');
      const closedOut = await conversation(call.conversationId);
      expect(closedOut).toMatchObject({ outcome: 'abandoned', channel: 'phone' });
      expect(closedOut.duration_seconds).toBeGreaterThanOrEqual(0);
    });

    it('staff can review it, and it names the staff member who ran it', async () => {
      const call = await startCall(token.admin);
      const client = await openSession(call.sessionPath);
      setup(client, call.callSid);
      prompt(client, 'hello there');
      await until(() => messageOfType(client, 'text') !== undefined);
      const detail = (await as(app, token.owner).get(`/api/conversations/${call.conversationId}`).expect(200)).body as ConversationDetail;
      expect(detail).toMatchObject({ channel: 'phone', status: 'active', startedByName: 'Member admin@alpha.test' });
      expect(detail.turns.map((turn) => turn.text)).toContain('hello there');
    });

    it('an emergency gets the fixed message, which cannot be talked over, without asking the model', async () => {
      const call = await startCall();
      const client = await openSession(call.sessionPath);
      setup(client, call.callSid);
      prompt(client, 'I have chest pain');
      await until(() => messageOfType(client, 'text') !== undefined, 'the emergency message');
      expect(messageOfType(client, 'text')).toEqual({ type: 'text', token: `${EMERGENCY} ${EMERGENCY_REPLY_ALERT} ${CALLBACK_OFFER}`, last: true, interruptible: false });
      expect(model.requests).toHaveLength(0);
      expect(await conversation(call.conversationId)).toMatchObject({ status: 'active', escalation: 'emergency' });
    });

    it('when the receptionist ends the conversation, the browser is told the session is over', async () => {
      const call = await startCall();
      script(callTool('end_conversation', {}), say('Goodbye, take care.'));
      const client = await openSession(call.sessionPath);
      setup(client, call.callSid);
      prompt(client, 'That is all, thank you');
      await until(() => messageOfType(client, 'end') !== undefined, 'the end message');
      expect(client.received).toEqual([
        { type: 'text', token: 'Goodbye, take care.', last: true, interruptible: true },
        { type: 'end', handoffData: JSON.stringify({ reason: 'completed' }) },
      ]);
    });

    it('a session that announces a different call is closed and nothing is answered', async () => {
      const call = await startCall();
      const client = await openSession(call.sessionPath);
      setup(client, 'WEB00000000000000000000000000000000');
      prompt(client, 'hello');
      expect(await client.closed).toBe(1008);
      expect(model.requests).toHaveLength(0);
    });
  });
});
