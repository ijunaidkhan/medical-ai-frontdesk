import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WEEKDAYS, type ConversationDetail } from '@frontdesk/shared';
import request from 'supertest';
import WebSocket from 'ws';
import { callTool, say, ScriptedModel, type ScriptedStep } from '../src/agent/model/scripted-model.js';
import { CALLBACK_OFFER, EMERGENCY_REPLY_ALERT } from '../src/agent/safety/escalation.js';
import type { Db } from '../src/database/database.module.js';
import { addPhoneNumber } from '../src/voice/phone-admin.js';
import { RelayTokenService } from '../src/voice/relay-token.js';
import { expectedTwilioSignature } from '../src/voice/twilio-signature.js';
import { startTestApp } from './support/app.js';
import { as, signIn, uniqueIp, type TestApp } from './support/auth-helpers.js';
import { connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

// Voice is switched on for this file only (each test file runs in its own process).
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // made up, not a real credential
const BASE = 'https://calls.example.org';
process.env['VOICE_PROVIDER'] = 'twilio';
process.env['TWILIO_AUTH_TOKEN'] = TOKEN;
process.env['PUBLIC_BASE_URL'] = BASE;

const ALL_DAY = Object.fromEntries(WEEKDAYS.map((day) => [day, [{ open: '00:00', close: '24:00' }]]));
const EMERGENCY = 'If this is a medical emergency, hang up and call 911 now.';
const CRISIS = 'If you are thinking about suicide, call or text 988 now.';
const ALPHA_NUMBER = '+14155550101';
const CALLER = '+16505550199';

let sidCounter = 0;
const newSid = () => `CA${String(++sidCounter).padStart(32, '0')}`;

interface Client {
  ws: WebSocket;
  received: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

/** The handshake was refused with this HTTP status (it never became a WebSocket). */
class Refused extends Error {
  constructor(readonly status: number) {
    super(`refused with ${status}`);
  }
}

const until = async (condition: () => boolean | Promise<boolean>, what = 'the condition', ms = 4_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe('the live voice session', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let port: number;
  let alpha: SeededPractice;
  let token: string;
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
    app = await startTestApp({ model });
    await app.listen(0, '127.0.0.1'); // a real listening server, so real WebSocket clients can connect
    port = ((app.getHttpServer() as unknown as Server).address() as AddressInfo).port;
    token = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    await addPhoneNumber(owner, { practice: 'alpha', number: ALPHA_NUMBER });
    await as(app, token)
      .patch('/api/ai/settings', { greeting: 'Thank you for calling Alpha Clinic.', emergencyMessage: EMERGENCY, crisisMessage: CRISIS, businessHours: ALL_DAY })
      .expect(200);
    await as(app, token).patch('/api/ai/settings', { enabled: true }).expect(200);
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

  /** Twilio's first request about a call: creates the conversation and returns the address of the voice session. */
  async function startCall(): Promise<{ sid: string; relay: string; conversationId: string }> {
    const sid = newSid();
    const params = { CallSid: sid, From: CALLER, To: ALPHA_NUMBER };
    const res = await request(app.getHttpServer())
      .post('/api/voice/incoming')
      .set('X-Forwarded-For', uniqueIp())
      .set('X-Twilio-Signature', expectedTwilioSignature(TOKEN, `${BASE}/api/voice/incoming`, params))
      .type('form')
      .send(params)
      .expect(200);
    const relay = (/url="([^"]+)"/.exec(res.text)?.[1] ?? '').replace(/&amp;/g, '&');
    const claims = await relayTokens.verify(new URL(relay).searchParams.get('token') ?? '');
    return { sid, relay, conversationId: claims!.conversationId };
  }

  /** Opens the voice session the way Twilio does: to the address it was given, signed. */
  function openSession(relay: string, options: { signature?: string | null; pathAndQuery?: string } = {}): Promise<Client> {
    const publicUrl = new URL(relay); // wss://calls.example.org/api/voice/relay?token=...
    const pathAndQuery = options.pathAndQuery ?? `${publicUrl.pathname}${publicUrl.search}`;
    const signature = options.signature === undefined ? expectedTwilioSignature(TOKEN, `wss://calls.example.org${pathAndQuery}`, {}) : options.signature;
    const headers: Record<string, string> = signature === null ? {} : { 'X-Twilio-Signature': signature };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`, { headers });
      opened.push(ws);
      const received: Array<Record<string, unknown>> = [];
      ws.on('message', (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
      const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
      ws.once('open', () => resolve({ ws, received, closed }));
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        reject(new Refused(response.statusCode ?? 0));
      });
      ws.once('error', (error) => reject(error));
    });
  }

  const refusedWith = (promise: Promise<Client>) =>
    promise.then(
      () => 'opened',
      (error: unknown) => (error instanceof Refused ? error.status : `failed: ${String(error)}`),
    );

  const setup = (client: Client, sid: string) => client.ws.send(JSON.stringify({ type: 'setup', callSid: sid, from: CALLER, to: ALPHA_NUMBER }));
  const prompt = (client: Client, text: string) => client.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true }));
  const messageOfType = (client: Client, type: string) => client.received.find((message) => message['type'] === type);
  const conversation = (id: string) => owner.selectFrom('conversations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const turns = (id: string) => owner.selectFrom('conversation_turns').select(['seq', 'speaker', 'source', 'text']).where('conversation_id', '=', id).orderBy('seq').execute();

  // -------------------------------------------------------------- the handshake

  describe('the handshake refuses anything that is not Twilio’s genuine session for a live call', () => {
    it('with no token, a wrong token, or an expired token: 401', async () => {
      const { relay, conversationId } = await startCall();
      const path = new URL(relay).pathname;
      expect(await refusedWith(openSession(relay, { pathAndQuery: path }))).toBe(401);
      expect(await refusedWith(openSession(relay, { pathAndQuery: `${path}?token=not.a.token` }))).toBe(401);
      const expired = await relayTokens.sign({ conversationId, practiceId: alpha.practiceId }, new Date(Date.now() - 10 * 60_000));
      expect(await refusedWith(openSession(relay, { pathAndQuery: `${path}?token=${expired}` }))).toBe(401);
      const another = await new RelayTokenService('another-secret-0000000000000000000000').sign({ conversationId, practiceId: alpha.practiceId });
      expect(await refusedWith(openSession(relay, { pathAndQuery: `${path}?token=${another}` }))).toBe(401);
    });

    it('for any other WebSocket address: 404', async () => {
      const { relay } = await startCall();
      const search = new URL(relay).search;
      expect(await refusedWith(openSession(relay, { pathAndQuery: `/api/voice/other${search}` }))).toBe(404);
      expect(await refusedWith(openSession(relay, { pathAndQuery: `/${search}` }))).toBe(404);
    });

    it('with no Twilio signature, a signature made with another token, or one for a changed address: 403', async () => {
      const { relay } = await startCall();
      const { pathname, search } = new URL(relay);
      expect(await refusedWith(openSession(relay, { signature: null }))).toBe(403);
      expect(await refusedWith(openSession(relay, { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }))).toBe(403);
      expect(await refusedWith(openSession(relay, { signature: expectedTwilioSignature('another-token-0000000000000000', `wss://calls.example.org${pathname}${search}`, {}) }))).toBe(403);
      expect(await refusedWith(openSession(relay, { signature: expectedTwilioSignature(TOKEN, `wss://evil.example.org${pathname}${search}`, {}) }))).toBe(403);
    });

    it('accepts the signature whether Twilio signs the address as wss:// or https:// (its documentation does not say)', async () => {
      const first = await startCall();
      const asHttps = expectedTwilioSignature(TOKEN, `https://calls.example.org${new URL(first.relay).pathname}${new URL(first.relay).search}`, {});
      expect(await refusedWith(openSession(first.relay, { signature: asHttps }))).toBe('opened');
      const second = await startCall();
      expect(await refusedWith(openSession(second.relay))).toBe('opened');
    });

    it('for a call that has already ended: 410', async () => {
      const { relay, conversationId } = await startCall();
      await owner.updateTable('conversations').set({ status: 'completed', outcome: 'answered', ended_at: new Date() }).where('id', '=', conversationId).execute();
      expect(await refusedWith(openSession(relay))).toBe(410);
    });

    it('only one session per call: a second attempt is refused (409), even after the first has closed', async () => {
      const { relay } = await startCall();
      const first = await openSession(relay);
      expect(await refusedWith(openSession(relay))).toBe(409);
      first.ws.close();
      await first.closed;
      expect(await refusedWith(openSession(relay))).toBe(409);
    });

    it('a text-chat conversation cannot be driven by a voice session, and a call cannot be driven through the text chat', async () => {
      const chat = (await as(app, token).post('/api/agent/test-conversations').expect(201)).body as { conversationId: string };
      const forged = await relayTokens.sign({ conversationId: chat.conversationId, practiceId: alpha.practiceId });
      const { relay, conversationId } = await startCall();
      expect(await refusedWith(openSession(relay, { pathAndQuery: `/api/voice/relay?token=${forged}`, signature: expectedTwilioSignature(TOKEN, `wss://calls.example.org/api/voice/relay?token=${forged}`, {}) }))).toBe(410);
      await as(app, token).post(`/api/agent/test-conversations/${conversationId}/messages`, { text: 'hello' }).expect(404);
    });
  });

  // -------------------------------------------------------------- a call

  describe('a call, as Twilio plays it', () => {
    it('answers what the caller says, stores both sides, and closes out the call when the caller hangs up', async () => {
      const { sid, relay, conversationId } = await startCall();
      script(callTool('get_practice_info', {}), say('We are open every day, all day.'));
      const client = await openSession(relay);
      setup(client, sid);
      prompt(client, 'What are your hours?');
      await until(() => messageOfType(client, 'text') !== undefined, 'the reply');

      expect(messageOfType(client, 'text')).toEqual({ type: 'text', token: 'We are open every day, all day.', last: true, interruptible: true });
      expect((await turns(conversationId)).map((turn) => [turn.speaker, turn.source, turn.text])).toEqual([
        ['ai', 'greeting', expect.stringContaining('Thank you for calling Alpha Clinic.')],
        ['caller', 'caller', 'What are your hours?'],
        ['ai', 'model', 'We are open every day, all day.'],
      ]);
      // The model was told this is a phone call, so its words are short and speakable.
      expect(model.requests[0]!.system).toContain('This is a live PHONE CALL');

      expect((await conversation(conversationId)).status).toBe('active');
      client.ws.close(); // the caller hung up
      await until(async () => (await conversation(conversationId)).status === 'completed', 'the call to be closed out');
      const closedOut = await conversation(conversationId);
      expect(closedOut).toMatchObject({ outcome: 'abandoned', channel: 'phone' });
      expect(closedOut.ended_at).not.toBeNull();
      expect(closedOut.duration_seconds).toBeGreaterThanOrEqual(0);
    });

    it('the transcript of a phone call can be reviewed like any other', async () => {
      const { sid, relay, conversationId } = await startCall();
      const client = await openSession(relay);
      setup(client, sid);
      prompt(client, 'hello there');
      await until(() => messageOfType(client, 'text') !== undefined);
      const detail = (await as(app, token).get(`/api/conversations/${conversationId}`).expect(200)).body as ConversationDetail;
      expect(detail).toMatchObject({ channel: 'phone', status: 'active', startedByName: null });
      expect(detail.turns.map((turn) => turn.text)).toContain('hello there');
    });

    it('an emergency gets the fixed message, which cannot be talked over, without the model; the call stays open for a callback', async () => {
      const { sid, relay, conversationId } = await startCall();
      const client = await openSession(relay);
      setup(client, sid);
      prompt(client, 'I have chest pain and I need an appointment');
      await until(() => messageOfType(client, 'text') !== undefined, 'the emergency message');

      expect(messageOfType(client, 'text')).toEqual({
        type: 'text',
        token: `${EMERGENCY} ${EMERGENCY_REPLY_ALERT} ${CALLBACK_OFFER}`,
        last: true,
        interruptible: false,
      });
      expect(messageOfType(client, 'end')).toBeUndefined(); // still on the line, to take a callback request
      expect(model.requests).toHaveLength(0); // the model was never asked
      expect(await conversation(conversationId)).toMatchObject({ status: 'active', escalation: 'emergency' });
      const tasks = await owner.selectFrom('staff_tasks').selectAll().where('conversation_id', '=', conversationId).execute();
      expect(tasks).toMatchObject([{ priority: 'urgent', created_by_type: 'ai' }]);

      client.ws.close();
      await until(async () => (await conversation(conversationId)).status === 'completed');
      expect((await conversation(conversationId)).outcome).toBe('emergency'); // earned, so not "abandoned"
    });

    it('takes a callback request by voice: the task is real, and the call closes out as a message taken', async () => {
      const { sid, relay, conversationId } = await startCall();
      script(
        callTool('create_staff_task', { type: 'callback', title: 'Wants an appointment', contactName: 'Jane', contactPhone: '+14155550123' }),
        say('Thank you Jane, I have passed your details to our team.'),
      );
      const client = await openSession(relay);
      setup(client, sid);
      prompt(client, 'Please ask someone to call me about an appointment, my name is Jane and my number is four one five five five five zero one two three');
      await until(() => messageOfType(client, 'text') !== undefined);
      expect(await owner.selectFrom('staff_tasks').selectAll().where('conversation_id', '=', conversationId).execute()).toMatchObject([
        { type: 'callback', created_by_type: 'ai', contact_phone: '+14155550123' },
      ]);
      client.ws.close();
      await until(async () => (await conversation(conversationId)).status === 'completed');
      expect((await conversation(conversationId)).outcome).toBe('message_taken');
    });

    it('when the receptionist finishes the conversation, Twilio is told the session is over', async () => {
      const { sid, relay, conversationId } = await startCall();
      script(callTool('end_conversation', {}), say('Goodbye, take care.'));
      const client = await openSession(relay);
      setup(client, sid);
      prompt(client, 'That is all, thank you');
      await until(() => messageOfType(client, 'end') !== undefined, 'the end message');
      expect(client.received).toEqual([
        { type: 'text', token: 'Goodbye, take care.', last: true, interruptible: true },
        { type: 'end', handoffData: JSON.stringify({ reason: 'completed' }) },
      ]);
      expect(await conversation(conversationId)).toMatchObject({ status: 'completed', outcome: 'answered' });
    });

    it('a reply the safety check blocks never reaches the caller', async () => {
      const { sid, relay } = await startCall();
      script(say('You probably have an infection, take two tablets of ibuprofen.'));
      const client = await openSession(relay);
      setup(client, sid);
      prompt(client, 'My arm feels strange');
      await until(() => messageOfType(client, 'text') !== undefined);
      expect(String(messageOfType(client, 'text')!['token'])).not.toContain('infection');
      expect(String(messageOfType(client, 'text')!['token'])).toContain('not able to help with that here');
    });
  });

  describe('a session that misbehaves is closed', () => {
    it('Twilio announcing a different call: closed (1008), and nothing is answered', async () => {
      const { relay } = await startCall();
      const client = await openSession(relay);
      setup(client, 'CA99999999999999999999999999999999');
      prompt(client, 'hello');
      expect(await client.closed).toBe(1008);
      expect(client.received).toEqual([]);
      expect(model.requests).toHaveLength(0);
    });

    it('a caller turn before the setup: closed (1008)', async () => {
      const { relay } = await startCall();
      const client = await openSession(relay);
      prompt(client, 'hello');
      expect(await client.closed).toBe(1008);
      expect(model.requests).toHaveLength(0);
    });

    it('a message larger than any Twilio would send: the connection is dropped and nothing is answered', async () => {
      const { sid, relay } = await startCall();
      const client = await openSession(relay);
      setup(client, sid);
      client.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'x'.repeat(100_000), last: true }));
      // 1009 ("too big"), or 1006 when the connection is dropped before the client reads the close frame.
      expect([1006, 1009]).toContain(await client.closed);
      expect(model.requests).toHaveLength(0);
    });

    it('rubbish that is not JSON is ignored a few times and then the session is closed', async () => {
      const { sid, relay } = await startCall();
      const client = await openSession(relay);
      setup(client, sid);
      for (let i = 0; i < 5; i += 1) client.ws.send('this is not json');
      expect(await client.closed).toBe(1008);
    });
  });

  describe('many calls at once never mix', () => {
    it('five simultaneous calls each get their own answers, in their own transcripts', async () => {
      const calls = await Promise.all(Array.from({ length: 5 }, () => startCall()));
      const clients = await Promise.all(calls.map((call) => openSession(call.relay)));
      calls.forEach((call, i) => setup(clients[i]!, call.sid));
      calls.forEach((_call, i) => prompt(clients[i]!, `caller number ${i} asks about parking`));
      await Promise.all(clients.map((client) => until(() => messageOfType(client, 'text') !== undefined, 'every reply')));

      for (const [i, client] of clients.entries()) {
        expect(messageOfType(client, 'text')!['token']).toBe(`Echo: caller number ${i} asks about parking`);
        const said = (await turns(calls[i]!.conversationId)).filter((turn) => turn.speaker === 'caller').map((turn) => turn.text);
        expect(said).toEqual([`caller number ${i} asks about parking`]);
      }
    });

    it('a caller talking quickly gets answers in the order they spoke', async () => {
      const { sid, relay, conversationId } = await startCall();
      const client = await openSession(relay);
      setup(client, sid);
      for (const text of ['first question', 'second question', 'third question']) prompt(client, text);
      await until(() => client.received.filter((message) => message['type'] === 'text').length === 3, 'three replies');
      expect(client.received.map((message) => message['token'])).toEqual(['Echo: first question', 'Echo: second question', 'Echo: third question']);
      expect((await turns(conversationId)).map((turn) => turn.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]); // no gaps, no repeats
    });
  });
});
