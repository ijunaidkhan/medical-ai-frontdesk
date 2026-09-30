import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WEEKDAYS, type AgentReply, type ConversationDetail, type StartConversationResponse } from '@frontdesk/shared';
import { AnthropicModel } from '../src/agent/model/anthropic-model.js';
import { SAFE_FALLBACK_REPLY } from '../src/agent/safety/output-guard.js';
import type { Db } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import { as, signIn, type TestApp } from './support/auth-helpers.js';
import { connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const KEY = 'sk-test-0123456789-abcdefghijklmnopqrstuvwxyz';
const ALL_DAY = Object.fromEntries(WEEKDAYS.map((day) => [day, [{ open: '00:00', close: '24:00' }]]));

interface Seen {
  headers: IncomingMessage['headers'];
  body: { model: string; system: string; max_tokens: number; tools?: Array<{ name: string }>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
}

/**
 * The real stack (app, database, tools, knowledge search, safety checks) with the
 * real Anthropic adapter, talking over real HTTP to a local stand-in for
 * Anthropic's API. Nothing here reaches the internet or needs a key.
 */
describe('the AI receptionist with the Anthropic adapter', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let token: string;
  let fake: Server;

  const seen: Seen[] = [];
  /** What the stand-in answers next: a status and a body. */
  const answers: Array<{ status: number; body: unknown }> = [];

  const start = async () => (await as(app, token).post('/api/agent/test-conversations').expect(201)).body as StartConversationResponse;
  const send = async (id: string, text: string) => (await as(app, token).post(`/api/agent/test-conversations/${id}/messages`, { text }).expect(200)).body as AgentReply;
  const detail = async (id: string) => (await as(app, token).get(`/api/conversations/${id}`).expect(200)).body as ConversationDetail;
  const text = (content: string) => ({ status: 200, body: { content: [{ type: 'text', text: content }] } });

  beforeAll(async () => {
    fake = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Seen['body'] });
        const answer = answers.shift() ?? { status: 500, body: { error: 'nothing scripted' } };
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1/messages`;

    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    app = await startTestApp({ model: new AnthropicModel({ apiKey: KEY, model: 'claude-test', baseUrl }) });
    token = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;

    await as(app, token)
      .patch('/api/ai/settings', {
        greeting: 'Thank you for calling Alpha Clinic.',
        emergencyMessage: 'If this is a medical emergency, hang up and call 911 now.',
        crisisMessage: 'If you are thinking about suicide, call or text 988 now.',
        businessHours: ALL_DAY,
      })
      .expect(200);
    const created = (await as(app, token).post('/api/knowledge', { title: 'Insurance', category: 'insurance_billing', content: 'We accept Blue Cross and Aetna insurance plans.' }).expect(201)).body as { id: string };
    await as(app, token).post(`/api/knowledge/${created.id}/approve`).expect(200);
  });

  beforeEach(() => {
    seen.length = 0;
    answers.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await owner.destroy();
    await database.drop();
  });

  it('answers a question through a real tool round trip: greeting, tool call, knowledge search, tool result, reply', async () => {
    const { conversationId } = await start();
    answers.push(
      { status: 200, body: { content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_1', name: 'search_knowledge', input: { question: 'Do you take insurance?' } }] } },
      text('Yes, we accept Blue Cross and Aetna.'),
    );
    const reply = await send(conversationId, 'Do you take insurance?');
    expect(reply).toMatchObject({ reply: 'Yes, we accept Blue Cross and Aetna.', source: 'model', status: 'active' });

    // Two calls to "Anthropic": the question, then the question plus the tool's result.
    expect(seen).toHaveLength(2);
    const [first, second] = seen as [Seen, Seen];
    expect(first.headers['x-api-key']).toBe(KEY);
    expect(first.headers['anthropic-version']).toBe('2023-06-01');
    expect(first.body.model).toBe('claude-test');
    expect(first.body.tools?.map((tool) => tool.name)).toEqual(['search_knowledge', 'get_practice_info', 'create_staff_task', 'request_human_handoff', 'end_conversation']);
    expect(first.body.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Do you take insurance?' }] }); // starts with the caller
    expect(first.body.system).toContain('Thank you for calling Alpha Clinic.'); // the greeting went into the system text
    expect(first.body.system).toContain('Practice alpha');

    const roles = second.body.messages.map((message) => message.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(second.body.messages[1]!.content.map((block) => block['type'])).toEqual(['text', 'tool_use']);
    const toolResult = second.body.messages[2]!.content[0]!;
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(String(toolResult['content'])).toContain('Blue Cross and Aetna'); // the real approved knowledge, found by the real search

    // What left the building must not include the practice's internal id or any key.
    for (const call of seen) {
      expect(JSON.stringify(call.body)).not.toContain(alpha.practiceId);
      expect(JSON.stringify(call.body)).not.toContain(KEY);
    }

    const d = await detail(conversationId);
    expect(d.model).toBe('anthropic:claude-test');
    expect(d.toolCalls).toMatchObject([{ tool: 'search_knowledge', status: 'ok' }]);
  });

  it('a reply the checker blocks never reaches the caller, even from a real model', async () => {
    const { conversationId } = await start();
    answers.push(text('You probably have an infection, so take two tablets of ibuprofen.'));
    const reply = await send(conversationId, 'My arm feels strange and I want to know what it is');
    expect(reply).toMatchObject({ reply: SAFE_FALLBACK_REPLY, source: 'scripted_guard' });
  });

  it('an emergency never reaches the model at all', async () => {
    const { conversationId } = await start();
    const reply = await send(conversationId, 'I have chest pain');
    expect(reply.source).toBe('scripted_emergency');
    expect(seen).toHaveLength(0);
  });

  it.each([
    [429, 'model_unavailable'],
    [529, 'model_unavailable'],
    [500, 'model_unavailable'],
    [401, 'model_error'],
  ])('a %i from the API gets the safe line, marked %s, and the conversation carries on', async (status, reason) => {
    const { conversationId } = await start();
    answers.push({ status, body: { error: { message: `secret detail ${KEY}` } } });
    const reply = await send(conversationId, 'hello');
    expect(reply).toMatchObject({ reply: SAFE_FALLBACK_REPLY, status: 'active', source: 'scripted_guard' });
    const d = await detail(conversationId);
    expect(d.turns.at(-1)).toMatchObject({ guardReason: reason });
    expect(JSON.stringify(d)).not.toContain('secret detail'); // nothing the vendor said is stored or shown

    answers.push(text('Hello again, how can I help?'));
    expect(await send(conversationId, 'hello?')).toMatchObject({ reply: 'Hello again, how can I help?', source: 'model' });
  });

  it('after an emergency the real model is offered only the two message-only tools', async () => {
    const { conversationId } = await start();
    await send(conversationId, 'I have chest pain and I need an appointment');
    answers.push(text('Thank you. May I take your name and number so the team can call you back?'));
    await send(conversationId, 'yes please');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.tools?.map((tool) => tool.name)).toEqual(['create_staff_task', 'end_conversation']);
    expect(seen[0]!.body.system).toContain('already been given emergency or urgent instructions');
    // It can see why they called, so the callback request can mention the appointment.
    expect(JSON.stringify(seen[0]!.body.messages)).toContain('I need an appointment');
  });

  it('the final round without tools still works: earlier tool calls are sent as plain text', async () => {
    const { conversationId } = await start();
    // The model keeps asking for tools (3 rounds), then must answer without any on the 4th call.
    for (let i = 0; i < 3; i += 1) {
      answers.push({ status: 200, body: { content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'get_practice_info', input: {} }] } });
    }
    answers.push(text('We are open all day, every day.'));
    const reply = await send(conversationId, 'When are you open?');
    expect(reply.reply).toBe('We are open all day, every day.');
    const last = seen.at(-1)!;
    expect(last.body.tools).toBeUndefined();
    expect(JSON.stringify(last.body.messages)).not.toContain('tool_use');
    expect(JSON.stringify(last.body.messages)).toContain('Result of the tool get_practice_info');
  });
});
