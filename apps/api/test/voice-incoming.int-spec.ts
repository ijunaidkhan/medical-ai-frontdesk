import { composeGreeting, WEEKDAYS } from '@frontdesk/shared';
import request from 'supertest';
import { ScriptedModel } from '../src/agent/model/scripted-model.js';
import type { Db } from '../src/database/database.module.js';
import { RelayTokenService } from '../src/voice/relay-token.js';
import { expectedTwilioSignature } from '../src/voice/twilio-signature.js';
import { startTestApp } from './support/app.js';
import { as, signIn, uniqueIp, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';
import { addPhoneNumber, setPhoneNumberActive } from '../src/voice/phone-admin.js';

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
const BETA_NUMBER = '+16175550199';
const GAMMA_NUMBER = '+12125550123';
const SUSPENDED_NUMBER = '+13105550111';
const CALLER = '+16505550199';

let sidCounter = 0;
const newSid = () => `CA${String(++sidCounter).padStart(32, '0')}`;

describe('incoming phone calls', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  let gamma: SeededPractice;
  let tokens: { alpha: string; beta: string; gamma: string };
  const model = new ScriptedModel([]);
  const relayTokens = new RelayTokenService(process.env['ACCESS_TOKEN_SECRET'] ?? '');

  /** A request exactly as Twilio would send it: form fields and a signature over the public address. */
  const call = (path: string, params: Record<string, string>, options: { signature?: string | null; target?: TestApp } = {}) => {
    const signature = options.signature === undefined ? expectedTwilioSignature(TOKEN, `${BASE}/api/voice/${path}`, params) : options.signature;
    let req = request((options.target ?? app).getHttpServer()).post(`/api/voice/${path}`).set('X-Forwarded-For', uniqueIp());
    if (signature !== null) req = req.set('X-Twilio-Signature', signature);
    return req.type('form').send(params);
  };
  const incoming = (to: string, sid = newSid(), extra: Record<string, string> = {}) => call('incoming', { CallSid: sid, From: CALLER, To: to, CallStatus: 'ringing', ...extra });
  const conversationsFor = (practiceId: string) => owner.selectFrom('conversations').selectAll().where('practice_id', '=', practiceId).execute();
  const audit = (action: string) => owner.selectFrom('audit_logs').selectAll().where('action', '=', action).orderBy('occurred_at').execute();
  const relayUrl = (xml: string) => /url="([^"]+)"/.exec(xml)?.[1]?.replace(/&amp;/g, '&') ?? '';
  const relayToken = (xml: string) => new URL(relayUrl(xml)).searchParams.get('token') ?? '';
  const says = (xml: string) => [...xml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((match) => match[1]);

  async function configure(token: string, extra: Record<string, unknown> = {}) {
    await as(app, token)
      .patch('/api/ai/settings', { greeting: 'Thank you for calling Alpha Clinic.', emergencyMessage: EMERGENCY, crisisMessage: CRISIS, businessHours: ALL_DAY, ...extra })
      .expect(200);
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    gamma = await seedPractice(owner, 'gamma');
    const suspended = await seedPractice(owner, 'gone');
    await addMember(owner, alpha.practiceId, 'admin@alpha.test', 'admin');
    app = await startTestApp({ model });
    tokens = {
      alpha: (await signIn(app, { email: alpha.ownerEmail })).session.accessToken,
      beta: (await signIn(app, { email: beta.ownerEmail })).session.accessToken,
      gamma: (await signIn(app, { email: gamma.ownerEmail })).session.accessToken,
    };

    await addPhoneNumber(owner, { practice: 'alpha', number: ALPHA_NUMBER });
    await addPhoneNumber(owner, { practice: 'beta', number: BETA_NUMBER });
    await addPhoneNumber(owner, { practice: 'gamma', number: GAMMA_NUMBER });
    await addPhoneNumber(owner, { practice: 'gone', number: SUSPENDED_NUMBER });
    await owner.updateTable('practices').set({ status: 'suspended' }).where('id', '=', suspended.practiceId).execute();

    // Alpha is fully set up and switched on. Beta has its messages but the AI is off.
    await configure(tokens.alpha);
    await as(app, tokens.alpha).patch('/api/ai/settings', { enabled: true }).expect(200);
    await configure(tokens.beta, { greeting: 'Beta Pediatrics here.' });
    // Gamma was switched on, then its business hours were lost: no longer ready.
    await configure(tokens.gamma);
    await as(app, tokens.gamma).patch('/api/ai/settings', { enabled: true }).expect(200);
    await owner.updateTable('ai_settings').set({ business_hours: {} as never }).where('practice_id', '=', gamma.practiceId).execute();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  describe('the request must come from Twilio', () => {
    it('a request with no signature, a wrong one, or changed parameters is refused (403) and does nothing', async () => {
      const before = (await conversationsFor(alpha.practiceId)).length;
      const params = { CallSid: newSid(), From: CALLER, To: ALPHA_NUMBER };
      await call('incoming', params, { signature: null }).expect(403);
      await call('incoming', params, { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }).expect(403);
      const genuine = expectedTwilioSignature(TOKEN, `${BASE}/api/voice/incoming`, params);
      await call('incoming', { ...params, To: BETA_NUMBER }, { signature: genuine }).expect(403); // signed for a different number
      await call('incoming', params, { signature: expectedTwilioSignature('another-token-0000000000000000', `${BASE}/api/voice/incoming`, params) }).expect(403);
      expect((await conversationsFor(alpha.practiceId)).length).toBe(before);
    });

    it('a signature made for another address (another route) is refused', async () => {
      const params = { CallSid: newSid(), From: CALLER, To: ALPHA_NUMBER };
      await call('incoming', params, { signature: expectedTwilioSignature(TOKEN, `${BASE}/api/voice/action`, params) }).expect(403);
    });

    it('needs no login: a user’s access token does not help, and is not needed', async () => {
      await request(app.getHttpServer()).post('/api/voice/incoming').set('Authorization', `Bearer ${tokens.alpha}`).type('form').send({ CallSid: newSid(), To: ALPHA_NUMBER }).expect(403);
    });

    it('is not slowed by the per-IP limit (every call arrives from Twilio’s few addresses)', async () => {
      const statuses = new Set<number>();
      for (let i = 0; i < 320; i += 1) {
        const params = { CallSid: newSid(), From: CALLER, To: '+19995550100' };
        const signature = expectedTwilioSignature(TOKEN, `${BASE}/api/voice/incoming`, params);
        const res = await request(app.getHttpServer()).post('/api/voice/incoming').set('X-Forwarded-For', '198.51.100.7').set('X-Twilio-Signature', signature).type('form').send(params);
        statuses.add(res.status);
      }
      expect([...statuses]).toEqual([200]);
    }, 60_000);
  });

  describe('an accepted call', () => {
    it('creates the conversation and connects the call to the voice session, with the greeting and the AI notice', async () => {
      const sid = newSid();
      const res = await incoming(ALPHA_NUMBER, sid).expect(200);
      expect(res.headers['content-type']).toContain('text/xml');
      expect(res.headers['cache-control']).toBe('no-store');
      const xml = res.text;
      expect(xml).toContain('<Connect action="https://calls.example.org/api/voice/action">');
      expect(xml).toContain('<ConversationRelay ');
      expect(xml).toContain('welcomeGreetingInterruptible="none"');
      expect(xml).toContain(`welcomeGreeting="${composeGreeting('Thank you for calling Alpha Clinic.')}"`);
      expect(xml).toContain('You are speaking with an automated AI assistant, not a person.');
      expect(relayUrl(xml)).toMatch(/^wss:\/\/calls\.example\.org\/api\/voice\/relay\?token=/);

      const [conversation] = await owner.selectFrom('conversations').selectAll().where('provider_call_sid', '=', sid).execute();
      const number = await owner.selectFrom('phone_numbers').select('id').where('e164', '=', ALPHA_NUMBER).executeTakeFirstOrThrow();
      expect(conversation).toMatchObject({
        practice_id: alpha.practiceId,
        channel: 'phone',
        status: 'active',
        caller_number: CALLER,
        phone_number_id: number.id,
        model: 'scripted',
        turn_count: 1,
        started_by: null,
      });
      const turns = await owner.selectFrom('conversation_turns').selectAll().where('conversation_id', '=', conversation!.id).execute();
      expect(turns).toMatchObject([{ seq: 1, speaker: 'ai', source: 'greeting', text: composeGreeting('Thank you for calling Alpha Clinic.') }]);

      // The token in the address ties the voice session to exactly this conversation of this practice.
      expect(await relayTokens.verify(relayToken(xml))).toEqual({ conversationId: conversation!.id, practiceId: alpha.practiceId });
    });

    it('is audited as started by the system, and the audit log never carries the caller’s number', async () => {
      const started = (await audit('conversation.started')).filter((row) => JSON.stringify(row.metadata).includes('phone'));
      expect(started.length).toBeGreaterThan(0);
      expect(started[0]).toMatchObject({ actor_type: 'system', actor_user_id: null, practice_id: alpha.practiceId });
      const everything = JSON.stringify(await owner.selectFrom('audit_logs').selectAll().execute());
      expect(everything).not.toContain(CALLER);
    });

    it('works for a caller who hides their number (no From, or a value that is not a number)', async () => {
      for (const from of [undefined, 'anonymous', 'client:alice']) {
        const sid = newSid();
        const params = { CallSid: sid, To: ALPHA_NUMBER, ...(from ? { From: from } : {}) };
        await call('incoming', params).expect(200);
        const row = await owner.selectFrom('conversations').select('caller_number').where('provider_call_sid', '=', sid).executeTakeFirstOrThrow();
        expect(row.caller_number).toBeNull();
      }
    });

    it('a greeting cannot add commands to what Twilio is told to do', async () => {
      await as(app, tokens.alpha).patch('/api/ai/settings', { greeting: '"/><Dial>+19995550100</Dial><Say x="' }).expect(200);
      try {
        const xml = (await incoming(ALPHA_NUMBER).expect(200)).text;
        expect(xml).not.toContain('<Dial>');
        expect(xml).toContain('&lt;Dial&gt;+19995550100&lt;/Dial&gt;');
        expect(xml.match(/<ConversationRelay /g)).toHaveLength(1);
      } finally {
        await as(app, tokens.alpha).patch('/api/ai/settings', { greeting: 'Thank you for calling Alpha Clinic.' }).expect(200);
      }
    });
  });

  describe('Twilio asks again: one call is one conversation', () => {
    it('answers a repeated request the same way, without a second conversation', async () => {
      const sid = newSid();
      const first = (await incoming(ALPHA_NUMBER, sid).expect(200)).text;
      const second = (await incoming(ALPHA_NUMBER, sid).expect(200)).text;
      const rows = await owner.selectFrom('conversations').select('id').where('provider_call_sid', '=', sid).execute();
      expect(rows).toHaveLength(1);
      expect((await relayTokens.verify(relayToken(first)))?.conversationId).toBe(rows[0]!.id);
      expect((await relayTokens.verify(relayToken(second)))?.conversationId).toBe(rows[0]!.id);
    });

    it('simultaneous identical requests still make exactly one conversation', async () => {
      const sid = newSid();
      const results = await Promise.all(Array.from({ length: 6 }, () => incoming(ALPHA_NUMBER, sid)));
      expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(results.every((res) => res.text.includes('<ConversationRelay '))).toBe(true);
      const rows = await owner.selectFrom('conversations').select('id').where('provider_call_sid', '=', sid).execute();
      expect(rows).toHaveLength(1);
      const ids = await Promise.all(results.map(async (res) => (await relayTokens.verify(relayToken(res.text)))?.conversationId));
      expect(new Set(ids)).toEqual(new Set([rows[0]!.id]));
    });

    it('a call that has already ended is just ended again, never reopened', async () => {
      const sid = newSid();
      await incoming(ALPHA_NUMBER, sid).expect(200);
      await owner.updateTable('conversations').set({ status: 'completed', outcome: 'answered', ended_at: new Date() }).where('provider_call_sid', '=', sid).execute();
      const res = await incoming(ALPHA_NUMBER, sid).expect(200);
      expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      expect((await owner.selectFrom('conversations').select('status').where('provider_call_sid', '=', sid).executeTakeFirstOrThrow()).status).toBe('completed');
    });
  });

  describe('a number that is not in service', () => {
    const notInService = '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">This number is not in service. Goodbye.</Say><Hangup/></Response>';

    it.each([
      ['a number nobody has', '+14155559999'],
      ['a suspended practice', SUSPENDED_NUMBER],
      ['something that is not a number', 'sip:alice@example.com'],
      ['an injection attempt', "+14155550101' or '1'='1"],
    ])('%s: a short message and goodbye, nothing created, nothing revealed', async (_name, to) => {
      const before = await owner.selectFrom('conversations').select('id').execute();
      const res = await incoming(to).expect(200);
      expect(res.text).toBe(notInService);
      expect((await owner.selectFrom('conversations').select('id').execute()).length).toBe(before.length);
    });

    it('a switched-off number answers nothing; switched back on, it answers again', async () => {
      await setPhoneNumberActive(owner, ALPHA_NUMBER, false);
      expect((await incoming(ALPHA_NUMBER).expect(200)).text).toBe(notInService);
      await setPhoneNumberActive(owner, ALPHA_NUMBER, true);
      expect((await incoming(ALPHA_NUMBER).expect(200)).text).toContain('<ConversationRelay ');
    });

    it.each([
      ['no number dialed', { CallSid: 'CA1' }],
      ['no call id', { To: ALPHA_NUMBER }],
      ['a call id with odd characters', { CallSid: "CA1'; drop table", To: ALPHA_NUMBER }],
      ['a call id that is far too long', { CallSid: `CA${'1'.repeat(80)}`, To: ALPHA_NUMBER }],
    ])('%s: the same short message', async (_name, params) => {
      const before = await owner.selectFrom('conversations').select('id').execute();
      const res = await call('incoming', params).expect(200);
      expect(res.text).toBe(notInService);
      expect((await owner.selectFrom('conversations').select('id').execute()).length).toBe(before.length);
    });
  });

  describe('when the AI cannot answer, the caller still hears the emergency and crisis messages', () => {
    it.each([
      ['the AI is switched off', BETA_NUMBER, 'ai_off', 'beta'],
      ['the AI is no longer ready (business hours lost)', GAMMA_NUMBER, 'not_ready', 'gamma'],
    ] as const)('%s -> spoken message, reason recorded, no conversation', async (_name, number, reason, which) => {
      const practice = which === 'beta' ? beta : gamma; // looked up now: the practices exist only after setup has run
      const before = (await conversationsFor(practice.practiceId)).length;
      const res = await incoming(number).expect(200);
      const spoken = says(res.text);
      expect(spoken[0]).toContain('Our automated assistant is not available right now');
      expect(spoken).toContain(EMERGENCY);
      expect(spoken).toContain(CRISIS);
      expect(res.text).toContain('<Hangup/>');
      expect(res.text).not.toContain('<ConversationRelay');
      expect((await conversationsFor(practice.practiceId)).length).toBe(before);

      const declined = (await audit('voice.call_declined')).filter((row) => row.practice_id === practice.practiceId).at(-1);
      expect(declined).toMatchObject({ actor_type: 'system', metadata: { reason } });
      expect(JSON.stringify(declined)).not.toContain(CALLER);
    });

    it('with no language model configured, the same (and the AI never pretends to answer)', async () => {
      const bare = await startTestApp(); // no model
      try {
        const res = await call('incoming', { CallSid: newSid(), From: CALLER, To: ALPHA_NUMBER }, { target: bare }).expect(200);
        expect(says(res.text)).toContain(EMERGENCY);
        expect(res.text).not.toContain('<ConversationRelay');
        expect((await audit('voice.call_declined')).at(-1)).toMatchObject({ metadata: { reason: 'no_model' } });
      } finally {
        await bare.close();
      }
    });

    it('the practice name in the spoken message is escaped like everything else', async () => {
      await owner.updateTable('practices').set({ name: 'Beta </Say><Dial>+19995550100</Dial>' }).where('id', '=', beta.practiceId).execute();
      const res = await incoming(BETA_NUMBER).expect(200);
      expect(res.text).not.toContain('<Dial>');
      expect(says(res.text)[0]).toContain('&lt;Dial&gt;');
    });
  });

  describe('each practice only ever gets its own calls', () => {
    it('a call to one practice’s number never creates anything in another', async () => {
      const betaBefore = (await conversationsFor(beta.practiceId)).length;
      const alphaBefore = (await conversationsFor(alpha.practiceId)).length;
      await incoming(ALPHA_NUMBER).expect(200);
      expect((await conversationsFor(beta.practiceId)).length).toBe(betaBefore);
      expect((await conversationsFor(alpha.practiceId)).length).toBe(alphaBefore + 1);
    });

    it('the same call id arriving for two practices gives each its own conversation', async () => {
      await as(app, tokens.beta).patch('/api/ai/settings', { enabled: true }).expect(200);
      try {
        const sid = newSid();
        const a = await incoming(ALPHA_NUMBER, sid).expect(200);
        const b = await incoming(BETA_NUMBER, sid).expect(200);
        const ca = await relayTokens.verify(relayToken(a.text));
        const cb = await relayTokens.verify(relayToken(b.text));
        expect(ca?.practiceId).toBe(alpha.practiceId);
        expect(cb?.practiceId).toBe(beta.practiceId);
        expect(ca?.conversationId).not.toBe(cb?.conversationId);
      } finally {
        await as(app, tokens.beta).patch('/api/ai/settings', { enabled: false }).expect(200);
      }
    });
  });

  describe('the route after a voice session ends', () => {
    it('ends the call (more arrives with the hand-over step), and only for a genuine Twilio request', async () => {
      const params = { CallSid: newSid(), SessionStatus: 'ended' };
      expect((await call('action', params).expect(200)).text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      await call('action', params, { signature: null }).expect(403);
    });
  });
});
