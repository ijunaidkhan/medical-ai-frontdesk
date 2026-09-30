import { createLanguageModel } from '../agent.module.js';
import { AnthropicModel, fromWire, toWire } from './anthropic-model.js';
import { ModelRequestError, ModelUnavailableError, UnconfiguredModel, type ModelRequest } from './language-model.js';

const KEY = 'sk-test-0123456789-abcdefghijklmnopqrstuvwxyz';

const TOOL = { name: 'search_knowledge', description: 'Search', parameters: { type: 'object', properties: { question: { type: 'string' } } } };
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'You are the receptionist.',
  messages: [
    { role: 'assistant', text: 'Thank you for calling. You are speaking with an automated AI assistant, not a person.' },
    { role: 'user', text: 'Do you take insurance?' },
  ],
  tools: [TOOL],
  ...extra,
});

/** A fake of the platform's fetch that records what was sent and answers as scripted. */
function fakeFetch(answer: { status?: number; body?: unknown; throws?: Error } = {}) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (answer.throws) return Promise.reject(answer.throws);
    const status = answer.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => (answer.body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(answer.body)),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const model = (answer?: Parameters<typeof fakeFetch>[0]) => {
  const fake = fakeFetch(answer ?? { body: { content: [{ type: 'text', text: 'Yes, we accept Blue Cross.' }] } });
  return { model: new AnthropicModel({ apiKey: KEY, model: 'claude-test', fetch: fake.impl }), ...fake };
};

describe('AnthropicModel', () => {
  it('names itself after the model, so conversations record which one answered', () => {
    expect(model().model).toMatchObject({ name: 'anthropic:claude-test', configured: true });
  });

  describe('the request', () => {
    it('goes to Anthropic with the key in a header (never in the body), the model, tools, and a token limit', async () => {
      const { model: m, calls } = model();
      await m.complete(request());
      const [call] = calls;
      expect(call!.url).toBe('https://api.anthropic.com/v1/messages');
      expect(call!.init.method).toBe('POST');
      expect(call!.init.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
      expect(JSON.stringify(call!.body)).not.toContain(KEY);
      expect(call!.body).toMatchObject({
        model: 'claude-test',
        max_tokens: 500,
        tools: [{ name: 'search_knowledge', description: 'Search', input_schema: TOOL.parameters }],
      });
    });

    it('moves the greeting into the system text, because the conversation must start with the caller', async () => {
      const { model: m, calls } = model();
      await m.complete(request());
      const body = calls[0]!.body as { system: string; messages: Array<{ role: string }> };
      expect(body.system).toContain('You are the receptionist.');
      expect(body.system).toContain('You have already said this to the caller: Thank you for calling.');
      expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Do you take insurance?' }] }]);
    });

    it('sends no tools field when none are offered', async () => {
      const { model: m, calls } = model();
      await m.complete(request({ tools: [] }));
      expect(calls[0]!.body).not.toHaveProperty('tools');
    });

    it('passes the abort signal on, so a timeout really stops the call', async () => {
      const { model: m, calls } = model();
      const controller = new AbortController();
      await m.complete(request(), controller.signal);
      expect(calls[0]!.init.signal).toBe(controller.signal);
    });
  });

  describe('translating the conversation', () => {
    const toolCall = { id: 'tc1', name: 'search_knowledge', arguments: { question: 'insurance' } };

    it('turns a tool call and its result into tool_use and tool_result blocks, result first in its message', () => {
      const { messages } = toWire(
        request({
          messages: [
            { role: 'user', text: 'Do you take insurance?' },
            { role: 'assistant', text: 'Let me check.', toolCalls: [toolCall] },
            { role: 'tool', toolCallId: 'tc1', name: 'search_knowledge', content: '{"found":true}' },
          ],
        }),
      );
      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Do you take insurance?' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tc1', name: 'search_knowledge', input: { question: 'insurance' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: '{"found":true}' }] },
      ]);
    });

    it('merges results of several calls into one message, and omits empty text', () => {
      const { messages } = toWire(
        request({
          messages: [
            { role: 'user', text: 'hi' },
            { role: 'assistant', text: '', toolCalls: [toolCall, { ...toolCall, id: 'tc2' }] },
            { role: 'tool', toolCallId: 'tc1', name: 'search_knowledge', content: 'a' },
            { role: 'tool', toolCallId: 'tc2', name: 'search_knowledge', content: 'b' },
          ],
        }),
      );
      expect(messages[1]!.content.map((block) => block.type)).toEqual(['tool_use', 'tool_use']);
      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc1', content: 'a' },
          { type: 'tool_result', tool_use_id: 'tc2', content: 'b' },
        ],
      });
    });

    it('puts a tool result before any other text in the same message (the API requires it)', () => {
      const { messages } = toWire(
        request({
          messages: [
            { role: 'user', text: 'hi' },
            { role: 'assistant', text: '', toolCalls: [toolCall] },
            { role: 'user', text: 'and one more thing' },
            { role: 'tool', toolCallId: 'tc1', name: 'search_knowledge', content: 'a' },
          ],
        }),
      );
      expect(messages[2]!.content.map((block) => block.type)).toEqual(['tool_result', 'text']);
    });

    it('writes tool blocks as plain text when no tools are offered (the API refuses them otherwise)', () => {
      const { messages } = toWire(
        request({
          tools: [],
          messages: [
            { role: 'user', text: 'hi' },
            { role: 'assistant', text: '', toolCalls: [toolCall] },
            { role: 'tool', toolCallId: 'tc1', name: 'search_knowledge', content: '{"found":true}' },
          ],
        }),
      );
      expect(JSON.stringify(messages)).not.toContain('tool_use');
      expect(JSON.stringify(messages)).not.toContain('tool_result');
      expect(JSON.stringify(messages)).toContain('Result of the tool search_knowledge');
    });

    it('merges back-to-back messages from one side, and drops empty ones, so the roles always alternate', () => {
      const { messages } = toWire(
        request({
          messages: [
            { role: 'user', text: 'first' },
            { role: 'user', text: 'second' },
            { role: 'assistant', text: '   ' },
            { role: 'assistant', text: 'answer' },
          ],
        }),
      );
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[0]!.content).toHaveLength(2);
    });

    it('keeps the system text unchanged when the AI has said nothing yet', () => {
      const { system } = toWire(request({ messages: [{ role: 'user', text: 'hi' }] }));
      expect(system).toBe('You are the receptionist.');
    });
  });

  describe('the answer', () => {
    it('joins text blocks and collects tool calls', async () => {
      const { model: m } = model({
        body: {
          content: [
            { type: 'text', text: 'One moment. ' },
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'tc9', name: 'search_knowledge', input: { question: 'parking' } },
          ],
        },
      });
      expect(await m.complete(request())).toEqual({
        text: 'One moment. Checking.',
        toolCalls: [{ id: 'tc9', name: 'search_knowledge', arguments: { question: 'parking' } }],
      });
    });

    it('treats odd tool input as no arguments rather than trusting it', () => {
      const result = fromWire({ content: [{ type: 'tool_use', id: 'a', name: 'x', input: 'not an object' }, { type: 'tool_use', id: 'b', name: 'y', input: ['list'] }, { type: 'tool_use', id: 'c', name: 'z' }] });
      expect(result.toolCalls.map((call) => call.arguments)).toEqual([{}, {}, {}]);
    });

    it('ignores block types it does not know, and keeps tool_use blocks that lack an id or a name out', () => {
      const result = fromWire({ content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hi.' }, { type: 'tool_use', name: 'x', input: {} }, 'junk', null] });
      expect(result).toEqual({ text: 'Hi.', toolCalls: [] });
    });

    it.each([[null], ['text'], [{}], [{ content: 'nope' }]])('treats %j as an unexpected answer', async (body) => {
      await expect(model({ body }).model.complete(request())).rejects.toBeInstanceOf(ModelUnavailableError);
    });
  });

  describe('when the API is not happy', () => {
    it.each([408, 409, 429, 500, 502, 503, 529])('%i is "unavailable": worth trying again later', async (status) => {
      await expect(model({ status }).model.complete(request())).rejects.toMatchObject({ name: 'ModelUnavailableError', message: `The model API answered ${status}` });
    });

    it.each([400, 401, 403, 404])('%i is a request problem (a wrong key or setting), not an outage', async (status) => {
      const error = await model({ status }).model.complete(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelRequestError);
      expect(error).toMatchObject({ status, message: `The model API refused the request (${status})` });
    });

    it('turns a network failure or an abort into "unavailable", without passing on the underlying error', async () => {
      const failure = new Error(`connect failed for key ${KEY}`);
      const error = await model({ throws: failure }).model.complete(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect((error as Error).message).not.toContain(KEY);
    });

    it('an answer that is not JSON is "unavailable"', async () => {
      await expect(model({ status: 200 }).model.complete(request())).rejects.toBeInstanceOf(ModelUnavailableError);
    });

    it('never puts the key, or anything the API sent back, in an error message', async () => {
      for (const status of [401, 429, 500]) {
        const { model: m } = model({ status, body: { error: { message: `bad key ${KEY}` } } });
        const error = (await m.complete(request()).catch((e: unknown) => e)) as Error;
        expect(error.message).not.toContain(KEY);
        expect(error.message).not.toContain('bad key');
      }
    });
  });
});

describe('createLanguageModel', () => {
  it('uses Anthropic only when it is chosen AND a key is present', () => {
    const chosen = createLanguageModel({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'claude-test' });
    expect(chosen).toBeInstanceOf(AnthropicModel);
    expect(chosen.name).toBe('anthropic:claude-test');
  });

  it.each([
    ['no provider', { LLM_PROVIDER: 'none' as const, ANTHROPIC_API_KEY: KEY }],
    ['a provider but no key', { LLM_PROVIDER: 'anthropic' as const, ANTHROPIC_API_KEY: undefined }],
  ])('is unconfigured with %s (a key alone does not switch the AI on)', (_name, config) => {
    const result = createLanguageModel({ ANTHROPIC_MODEL: 'claude-test', ...config });
    expect(result).toBeInstanceOf(UnconfiguredModel);
    expect(result.configured).toBe(false);
  });
});
