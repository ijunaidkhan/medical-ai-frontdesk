import { createLanguageModel } from '../agent.module.js';
import { ModelRequestError, ModelUnavailableError, UnconfiguredModel, type ModelRequest } from './language-model.js';
import { fromWire, OllamaModel, toWire } from './ollama-model.js';

const TOOL = { name: 'search_knowledge', description: 'Search', parameters: { type: 'object', properties: { question: { type: 'string' } } } };
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'You are the receptionist.',
  messages: [
    { role: 'assistant', text: 'Thank you for calling.' },
    { role: 'user', text: 'Do you take insurance?' },
  ],
  tools: [TOOL],
  ...extra,
});

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

const reply = (message: Record<string, unknown>) => ({ choices: [{ message }] });
const model = (answer?: Parameters<typeof fakeFetch>[0], extra: { baseUrl?: string } = {}) => {
  const fake = fakeFetch(answer ?? { body: reply({ role: 'assistant', content: 'Yes, we accept Blue Cross.' }) });
  return { model: new OllamaModel({ baseUrl: extra.baseUrl ?? 'http://localhost:11434', model: 'llama3.1:8b', timeoutMs: 90_000, fetch: fake.impl }), ...fake };
};

describe('OllamaModel', () => {
  it('names itself after the model, and allows the longer time a local model needs', () => {
    expect(model().model).toMatchObject({ name: 'ollama:llama3.1:8b', configured: true, timeoutMs: 90_000 });
  });

  describe('the request', () => {
    it('goes to the local Ollama chat address, with no key, the model, tools, low temperature and a token limit', async () => {
      const { model: m, calls } = model();
      await m.complete(request());
      const [call] = calls;
      expect(call!.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(call!.init.method).toBe('POST');
      expect(Object.keys(call!.init.headers as Record<string, string>)).toEqual(['content-type']); // nothing secret to send
      expect(call!.body).toMatchObject({
        model: 'llama3.1:8b',
        stream: false,
        temperature: 0.2,
        max_tokens: 500,
        tools: [{ type: 'function', function: { name: 'search_knowledge', description: 'Search', parameters: TOOL.parameters } }],
      });
    });

    it('tolerates a trailing slash on the address', async () => {
      const { model: m, calls } = model(undefined, { baseUrl: 'http://localhost:11434///' });
      await m.complete(request());
      expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
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
    const call = { id: 'call_1', name: 'search_knowledge', arguments: { question: 'insurance' } };

    it('puts the instructions first and keeps the conversation in order, greeting included', () => {
      expect(toWire(request())).toEqual([
        { role: 'system', content: 'You are the receptionist.' },
        { role: 'assistant', content: 'Thank you for calling.' },
        { role: 'user', content: 'Do you take insurance?' },
      ]);
    });

    it('turns a tool call and its result into the OpenAI form, with the arguments as a JSON string', () => {
      const wire = toWire(
        request({
          messages: [
            { role: 'user', text: 'Do you take insurance?' },
            { role: 'assistant', text: 'Let me check.', toolCalls: [call] },
            { role: 'tool', toolCallId: 'call_1', name: 'search_knowledge', content: '{"found":true}' },
          ],
        }),
      );
      expect(wire.slice(1)).toEqual([
        { role: 'user', content: 'Do you take insurance?' },
        { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_knowledge', arguments: '{"question":"insurance"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"found":true}' },
      ]);
    });

    it('writes tool calls and results as plain text when no tools are offered', () => {
      const wire = toWire(
        request({
          tools: [],
          messages: [
            { role: 'user', text: 'hi' },
            { role: 'assistant', text: '', toolCalls: [call] },
            { role: 'tool', toolCallId: 'call_1', name: 'search_knowledge', content: '{"found":true}' },
          ],
        }),
      );
      expect(JSON.stringify(wire)).not.toContain('tool_calls');
      expect(JSON.stringify(wire)).not.toContain('tool_call_id');
      expect(JSON.stringify(wire)).toContain('Result of the tool search_knowledge');
      expect(JSON.stringify(wire)).toContain('You asked to use the tool search_knowledge');
    });

    it('drops empty messages', () => {
      const wire = toWire(request({ messages: [{ role: 'user', text: '   ' }, { role: 'assistant', text: '' }, { role: 'user', text: 'real' }] }));
      expect(wire).toEqual([{ role: 'system', content: 'You are the receptionist.' }, { role: 'user', content: 'real' }]);
    });
  });

  describe('the answer', () => {
    it('returns the text', async () => {
      expect(await model().model.complete(request())).toEqual({ text: 'Yes, we accept Blue Cross.', toolCalls: [] });
    });

    it('reads tool calls whose arguments are a JSON string (the usual form)', () => {
      const result = fromWire(reply({ content: '', tool_calls: [{ id: 'abc', type: 'function', function: { name: 'search_knowledge', arguments: '{"question":"parking"}' } }] }));
      expect(result).toEqual({ text: '', toolCalls: [{ id: 'abc', name: 'search_knowledge', arguments: { question: 'parking' } }] });
    });

    it('also reads arguments that are already an object, and invents an id when a model leaves it out', () => {
      const result = fromWire(reply({ content: null, tool_calls: [{ function: { name: 'get_practice_info', arguments: { a: 1 } } }, { id: '', function: { name: 'end_conversation', arguments: '{}' } }] }));
      expect(result.toolCalls).toEqual([
        { id: 'call_0', name: 'get_practice_info', arguments: { a: 1 } },
        { id: 'call_1', name: 'end_conversation', arguments: {} },
      ]);
    });

    it.each([['not json'], ['[1,2]'], ['"text"'], ['null'], [42], [undefined]])('treats arguments %j as no arguments rather than trusting them', (args) => {
      const result = fromWire(reply({ tool_calls: [{ id: 'x', function: { name: 'create_staff_task', arguments: args } }] }));
      expect(result.toolCalls[0]!.arguments).toEqual({});
    });

    it('ignores tool calls without a usable name, and anything that is not a tool call', () => {
      const result = fromWire(reply({ tool_calls: [{ id: 'a', function: { name: '', arguments: '{}' } }, { id: 'b', function: {} }, { id: 'c' }, 'junk', null] }));
      expect(result.toolCalls).toEqual([]);
    });

    describe('a tool request written out as text (small models do this)', () => {
      const offered = ['search_knowledge', 'create_staff_task', 'end_conversation'];
      const asText = (content: string) => fromWire(reply({ role: 'assistant', content }), offered);

      it('is recovered when the whole reply is one well-formed request for an offered tool', () => {
        expect(asText('{"name": "create_staff_task", "parameters": {"type": "callback", "title": "x", "contactPhone": "+14155550123"}}')).toEqual({
          text: '',
          toolCalls: [{ id: 'call_text_0', name: 'create_staff_task', arguments: { type: 'callback', title: 'x', contactPhone: '+14155550123' } }],
        });
      });

      it('also with "arguments", inside a code fence, with spaces around it, or with no arguments at all', () => {
        expect(asText('{"name":"search_knowledge","arguments":{"question":"parking"}}').toolCalls[0]).toMatchObject({ name: 'search_knowledge', arguments: { question: 'parking' } });
        expect(asText('```json\n{"name":"end_conversation","parameters":{}}\n```').toolCalls[0]).toMatchObject({ name: 'end_conversation' });
        expect(asText('  \n {"name":"end_conversation"}  ').toolCalls[0]).toMatchObject({ name: 'end_conversation', arguments: {} });
      });

      describe('the one slip llama makes: the colon after "parameters" is left out (as in real chats)', () => {
        it('is repaired, and the last of two "type" entries wins (the first is the model copying the schema)', () => {
          const result = asText('{"name":"create_staff_task","parameters{"type":"string","details":"Wants an appointment","contactName":"Zara Malik","contactPhone":"+14155550177","type":"callback"}}');
          expect(result).toEqual({
            text: '',
            toolCalls: [
              { id: 'call_text_0', name: 'create_staff_task', arguments: { type: 'callback', details: 'Wants an appointment', contactName: 'Zara Malik', contactPhone: '+14155550177' } },
            ],
          });
        });

        it.each([
          ['"parameters"{ (only the colon missing)', '{"name":"search_knowledge","parameters"{"question":"parking"}}'],
          ['"arguments{', '{"name":"search_knowledge","arguments{"question":"parking"}}'],
          ['"args {', '{"name":"search_knowledge","args {"question":"parking"}}'],
        ])('also with %s', (_name, content) => {
          expect(asText(content).toolCalls).toMatchObject([{ name: 'search_knowledge', arguments: { question: 'parking' } }]);
        });

        it('is still not recovered when the request is cut short (nothing is guessed)', () => {
          const cut = '{"name":"create_staff_task","parameters{"}}';
          expect(asText(cut)).toEqual({ text: cut, toolCalls: [] });
        });

        it('is never repaired into a tool that was not offered, or with text around it', () => {
          expect(asText('{"name":"request_human_handoff","parameters{"reason":"x"}}').toolCalls).toEqual([]);
          expect(asText('Sure! {"name":"end_conversation","parameters{}}').toolCalls).toEqual([]);
        });
      });

      it.each([
        ['malformed JSON of any other kind (a missing comma)', '{"name":"create_staff_task","parameters":{"type":"callback" "title":"x"}}'],
        ['malformed JSON with the colon present but the brackets wrong', '{"name":"create_staff_task","parameters":{"type":"callback"}'],
        ['a tool that was not offered this turn', '{"name":"request_human_handoff","parameters":{}}'],
        ['an unknown tool', '{"name":"delete_everything","parameters":{}}'],
        ['text around the JSON', 'Sure! {"name":"end_conversation","parameters":{}}'],
        ['a list of requests', '[{"name":"end_conversation","parameters":{}}]'],
        ['no name', '{"parameters":{"a":1}}'],
        ['a name that is not text', '{"name":5,"parameters":{}}'],
        ['ordinary words', 'We are open all day.'],
        ['an empty reply', ''],
      ])('is not recovered from %s: it stays text, for the reply checker to deal with', (_name, content) => {
        const result = asText(content);
        expect(result.toolCalls).toEqual([]);
        expect(result.text).toBe(content.trim());
      });

      it('never replaces a genuine tool call, and needs the offered list (none offered means none recovered)', () => {
        const genuine = fromWire(reply({ content: '{"name":"end_conversation"}', tool_calls: [{ id: 'g1', function: { name: 'search_knowledge', arguments: '{}' } }] }), offered);
        expect(genuine.toolCalls.map((call) => call.name)).toEqual(['search_knowledge']);
        expect(fromWire(reply({ content: '{"name":"end_conversation"}' })).toolCalls).toEqual([]);
      });

      it('through a whole request, using the tools offered in that request', async () => {
        const body = reply({ role: 'assistant', content: '{"name":"search_knowledge","parameters":{"question":"parking"}}' });
        const result = await model({ body }).model.complete(request());
        expect(result.toolCalls).toMatchObject([{ name: 'search_knowledge', arguments: { question: 'parking' } }]);
      });
    });

    it('never says what a model "thinks" between think tags', () => {
      expect(fromWire(reply({ content: '<think>The caller wants hours. I should check.</think>We are open all day.' })).text).toBe('We are open all day.');
      expect(fromWire(reply({ content: '<think>a</think>One. <think>b\nmore</think>Two.' })).text).toBe('One. Two.');
    });

    it.each([[null], ['text'], [{}], [{ choices: [] }], [{ choices: [{}] }], [{ choices: [{ message: 'x' }] }]])('treats %j as an unexpected answer', async (body) => {
      await expect(model({ body }).model.complete(request())).rejects.toBeInstanceOf(ModelUnavailableError);
    });
  });

  describe('when Ollama is not happy', () => {
    it('Ollama not running: says so, and how to start it', async () => {
      const error = await model({ throws: new TypeError('fetch failed') }).model.complete(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect((error as Error).message).toContain('ollama serve');
    });

    it('a model that is not installed: says which one and how to install it (404)', async () => {
      const error = await model({ status: 404 }).model.complete(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelRequestError);
      expect((error as Error).message).toBe('Ollama does not have the model "llama3.1:8b". Install it with: ollama pull llama3.1:8b');
    });

    it.each([408, 429, 500, 503])('%i is "unavailable": worth trying again', async (status) => {
      await expect(model({ status }).model.complete(request())).rejects.toMatchObject({ name: 'ModelUnavailableError', message: `Ollama answered ${status}` });
    });

    it.each([400, 401, 403])('%i is a request problem, not an outage', async (status) => {
      await expect(model({ status }).model.complete(request())).rejects.toMatchObject({ name: 'ModelRequestError', status });
    });

    it('an answer that is not JSON is "unavailable"', async () => {
      await expect(model({ status: 200 }).model.complete(request())).rejects.toBeInstanceOf(ModelUnavailableError);
    });
  });
});

describe('createLanguageModel with Ollama', () => {
  it('uses Ollama when chosen, with its address, model and the longer timeout', () => {
    const chosen = createLanguageModel({
      LLM_PROVIDER: 'ollama',
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: 'claude-test',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'qwen2.5:7b',
      OLLAMA_TIMEOUT_SECONDS: 120,
    });
    expect(chosen).toBeInstanceOf(OllamaModel);
    expect(chosen).toMatchObject({ name: 'ollama:qwen2.5:7b', timeoutMs: 120_000, configured: true });
  });

  it('needs no key, and a key alone does not switch it on', () => {
    expect(createLanguageModel({ LLM_PROVIDER: 'ollama', ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: 'x' })).toBeInstanceOf(OllamaModel);
    expect(createLanguageModel({ LLM_PROVIDER: 'none', ANTHROPIC_API_KEY: 'sk-test-0123456789-abcdefghijklmnopqrstuvwxyz', ANTHROPIC_MODEL: 'x' })).toBeInstanceOf(UnconfiguredModel);
  });
});
