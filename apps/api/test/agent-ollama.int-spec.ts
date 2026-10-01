import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WEEKDAYS, type AgentReply, type ConversationDetail, type StartConversationResponse } from '@frontdesk/shared';
import { OllamaModel } from '../src/agent/model/ollama-model.js';
import { SAFE_FALLBACK_REPLY } from '../src/agent/safety/output-guard.js';
import type { Db } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import { as, signIn, type TestApp } from './support/auth-helpers.js';
import { connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const ALL_DAY = Object.fromEntries(WEEKDAYS.map((day) => [day, [{ open: '00:00', close: '24:00' }]]));

interface Seen {
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: { model: string; stream: boolean; tools?: Array<{ type: string; function: { name: string } }>; messages: Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string }> };
}

/**
 * The real stack (app, database, tools, knowledge search, safety checks) with the real
 * Ollama adapter, talking over real HTTP to a local stand-in that answers in Ollama's
 * (OpenAI-compatible) format. Nothing here needs Ollama installed.
 */
describe('the AI receptionist with the Ollama adapter', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let token: string;
  let fake: Server;

  const seen: Seen[] = [];
  const answers: Array<{ status: number; body: unknown; delayMs?: number }> = [];

  const start = async () => (await as(app, token).post('/api/agent/test-conversations').expect(201)).body as StartConversationResponse;
  const send = async (id: string, text: string) => (await as(app, token).post(`/api/agent/test-conversations/${id}/messages`, { text }).expect(200)).body as AgentReply;
  const detail = async (id: string) => (await as(app, token).get(`/api/conversations/${id}`).expect(200)).body as ConversationDetail;
  const said = (content: string) => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content } }] } });

  beforeAll(async () => {
    fake = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Seen['body'] });
        const answer = answers.shift() ?? { status: 500, body: {} };
        setTimeout(() => {
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(answer.body));
        }, answer.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    app = await startTestApp({ model: new OllamaModel({ baseUrl, model: 'llama3.1:8b', timeoutMs: 30_000 }) });
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

  it('answers a question through a real tool round trip: tool call, real knowledge search, tool result, reply', async () => {
    const { conversationId } = await start();
    answers.push(
      { status: 200, body: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_knowledge', arguments: '{"question":"Do you take insurance?"}' } }] } }] } },
      said('Yes, we accept Blue Cross and Aetna.'),
    );
    const reply = await send(conversationId, 'Do you take insurance?');
    expect(reply).toMatchObject({ reply: 'Yes, we accept Blue Cross and Aetna.', source: 'model', status: 'active' });

    expect(seen).toHaveLength(2);
    const [first, second] = seen as [Seen, Seen];
    expect(first.url).toBe('/v1/chat/completions');
    expect(Object.keys(first.headers)).not.toContain('authorization'); // no key exists to send
    expect(first.body).toMatchObject({ model: 'llama3.1:8b', stream: false });
    expect(first.body.tools?.map((tool) => tool.function.name)).toEqual(['search_knowledge', 'get_practice_info', 'create_staff_task', 'request_human_handoff', 'end_conversation']);
    expect(first.body.messages[0]).toMatchObject({ role: 'system' });
    expect(first.body.messages[0]!.content).toContain('Practice alpha');
    expect(first.body.messages.slice(1).map((message) => message.role)).toEqual(['assistant', 'user']); // the greeting, then the question

    const toolResult = second.body.messages.at(-1)!;
    expect(toolResult).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(toolResult.content).toContain('Blue Cross and Aetna'); // the real approved knowledge, found by the real search
    for (const call of seen) expect(JSON.stringify(call.body)).not.toContain(alpha.practiceId);

    const d = await detail(conversationId);
    expect(d.model).toBe('ollama:llama3.1:8b');
    expect(d.toolCalls).toMatchObject([{ tool: 'search_knowledge', status: 'ok' }]);
  });

  it('a small model that thinks aloud is never heard doing it', async () => {
    const { conversationId } = await start();
    answers.push(said('<think>The caller wants the hours; I should be brief.</think>We are open every day.'));
    expect((await send(conversationId, 'When are you open?')).reply).toBe('We are open every day.');
  });

  it('a tool request the model wrote out as text is carried out like a real tool call', async () => {
    const { conversationId } = await start();
    answers.push(
      said('{"name":"create_staff_task","parameters":{"type":"callback","title":"Wants an appointment","contactName":"Sam","contactPhone":"+14155550123"}}'),
      said('Thank you Sam, I have passed your details to our team.'),
    );
    const reply = await send(conversationId, 'I need an appointment, I am Sam, +14155550123');
    expect(reply).toMatchObject({ reply: 'Thank you Sam, I have passed your details to our team.', source: 'model' });
    expect(reply.createdTaskIds).toHaveLength(1);
    expect((await detail(conversationId)).toolCalls).toMatchObject([{ tool: 'create_staff_task', status: 'ok' }]);
    expect(JSON.stringify(seen[1]!.body.messages)).toContain('call_text_0'); // the model is told the result of its request
  });

  it('a garbled tool request is never read out to the caller: the model is told, tries once more, and if it is still code the safe line is said', async () => {
    const { conversationId } = await start();
    const garbled = '{"name":"create_staff_task","parameters{"type":"string","contactName":"","title":"Appointment Booking","type":"other"}}';
    answers.push(said(garbled), said(garbled));
    const reply = await send(conversationId, 'i need and appointment booking');
    expect(reply).toMatchObject({ reply: SAFE_FALLBACK_REPLY, source: 'scripted_guard' });
    expect(seen).toHaveLength(2);
    expect((await detail(conversationId)).turns.at(-1)).toMatchObject({ guardReason: 'tool_syntax', text: SAFE_FALLBACK_REPLY, blockedText: garbled });
  });

  it('a garbled request followed by a proper answer: the caller gets the proper answer', async () => {
    const { conversationId } = await start();
    answers.push(said('{"name":"search_knowledge","parameters{"q":1}}'), said('You will receive an email with the details of your appointment.'));
    const reply = await send(conversationId, 'how will i get confirmation');
    expect(reply).toMatchObject({ reply: 'You will receive an email with the details of your appointment.', source: 'model' });
  });

  it('a reply the checker blocks never reaches the caller, even from a local model', async () => {
    const { conversationId } = await start();
    answers.push(said('You probably have an infection, so take two tablets of ibuprofen.'));
    expect(await send(conversationId, 'What is wrong with me?')).toMatchObject({ reply: SAFE_FALLBACK_REPLY, source: 'scripted_guard' });
  });

  it('an emergency never reaches the model at all', async () => {
    const { conversationId } = await start();
    expect((await send(conversationId, 'I have chest pain')).source).toBe('scripted_emergency');
    expect(seen).toHaveLength(0);
  });

  it.each([
    [404, 'model_error'],
    [500, 'model_unavailable'],
  ])('a %i from Ollama gets the safe line, marked %s, and the conversation carries on', async (status, reason) => {
    const { conversationId } = await start();
    answers.push({ status, body: { error: 'some detail from Ollama' } });
    expect(await send(conversationId, 'hello')).toMatchObject({ reply: SAFE_FALLBACK_REPLY, status: 'active', source: 'scripted_guard' });
    const d = await detail(conversationId);
    expect(d.turns.at(-1)).toMatchObject({ guardReason: reason });
    expect(JSON.stringify(d)).not.toContain('some detail from Ollama'); // nothing the server said is stored or shown
    answers.push(said('Hello again, how can I help?'));
    expect(await send(conversationId, 'hello?')).toMatchObject({ reply: 'Hello again, how can I help?', source: 'model' });
  });

  it('a model that takes longer than its own time limit is cut off, and the caller gets the safe line instead of waiting forever', async () => {
    const impatient = await startTestApp({ model: new OllamaModel({ baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, model: 'llama3.1:8b', timeoutMs: 300 }) });
    try {
      const session = (await signIn(impatient, { email: alpha.ownerEmail })).session.accessToken;
      const { conversationId } = (await as(impatient, session).post('/api/agent/test-conversations').expect(201)).body as StartConversationResponse;
      answers.push({ ...said('too late'), delayMs: 1_500 });
      const started = Date.now();
      const reply = (await as(impatient, session).post(`/api/agent/test-conversations/${conversationId}/messages`, { text: 'hello' }).expect(200)).body as AgentReply;
      expect(Date.now() - started).toBeLessThan(1_300); // not the full 1.5 seconds
      expect(reply).toMatchObject({ reply: SAFE_FALLBACK_REPLY, source: 'scripted_guard' });
      const turns = ((await as(impatient, session).get(`/api/conversations/${conversationId}`).expect(200)).body as ConversationDetail).turns;
      expect(turns.at(-1)).toMatchObject({ guardReason: 'model_unavailable' });
    } finally {
      await impatient.close();
    }
  });

  it('after an emergency the local model is offered only the two message-only tools', async () => {
    const { conversationId } = await start();
    await send(conversationId, 'I have chest pain and I need an appointment');
    answers.push(said('Thank you. May I take your name and number so the team can call you back?'));
    await send(conversationId, 'yes please');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.tools?.map((tool) => tool.function.name)).toEqual(['create_staff_task', 'end_conversation']);
  });

  it('the final round without tools still works: earlier tool calls are sent as plain text', async () => {
    const { conversationId } = await start();
    for (let i = 0; i < 3; i += 1) {
      answers.push({ status: 200, body: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'get_practice_info', arguments: '{}' } }] } }] } });
    }
    answers.push(said('We are open all day, every day.'));
    expect((await send(conversationId, 'When are you open?')).reply).toBe('We are open all day, every day.');
    const last = seen.at(-1)!;
    expect(last.body.tools).toBeUndefined();
    expect(JSON.stringify(last.body.messages)).not.toContain('tool_calls');
    expect(JSON.stringify(last.body.messages)).toContain('Result of the tool get_practice_info');
  });
});
