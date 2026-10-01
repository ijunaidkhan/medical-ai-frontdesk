import {
  ModelRequestError,
  ModelUnavailableError,
  type LanguageModel,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
} from './language-model.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 500;
/** Low, so a small local model sticks to the instructions instead of improvising. */
const TEMPERATURE = 0.2;

export interface OllamaModelOptions {
  /** Where Ollama listens, e.g. http://localhost:11434 (no trailing slash). */
  baseUrl: string;
  /** A model installed in Ollama that supports tools, e.g. llama3.1:8b or qwen2.5:7b. */
  model: string;
  /** A model on a laptop is much slower than a hosted one. */
  timeoutMs: number;
  maxOutputTokens?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * A language model running on this computer (or any server that speaks the
 * OpenAI chat format) through Ollama. Free, nothing leaves the machine, and no
 * account or key is needed. It only translates; what the model may do, what is
 * checked and what is stored are decided elsewhere, exactly as for any other model.
 *
 * Small models follow instructions and use tools less reliably than a large hosted
 * model. The safety layers (fixed emergency scripts, the reply checker, validated
 * tools) do not depend on the model, so they work the same.
 */
export class OllamaModel implements LanguageModel {
  readonly configured = true;
  readonly name: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(private readonly options: OllamaModelOptions) {
    this.name = `ollama:${options.model}`;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch ?? fetch;
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: toWire(request),
      stream: false,
      temperature: TEMPERATURE,
      max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
    if (request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new ModelUnavailableError('Could not reach Ollama. Is it running? (start it with: ollama serve)');
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new ModelRequestError(`Ollama does not have the model "${this.options.model}". Install it with: ollama pull ${this.options.model}`, 404);
      }
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw retryable ? new ModelUnavailableError(`Ollama answered ${response.status}`) : new ModelRequestError(`Ollama refused the request (${response.status})`, response.status);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ModelUnavailableError('Ollama sent an unreadable answer');
    }
    return fromWire(data, request.tools.map((tool) => tool.name));
  }
}

// ------------------------------------------------------------------ translation

/**
 * Converts our neutral messages to the OpenAI chat format. When no tools are
 * offered (the last round of a turn), earlier tool calls and results are written
 * as plain text, since a server may refuse tool messages without tool definitions.
 * Empty messages are dropped.
 */
export function toWire(request: ModelRequest): WireMessage[] {
  const flatten = request.tools.length === 0;
  const wire: WireMessage[] = [{ role: 'system', content: request.system }];
  for (const message of request.messages as ModelMessage[]) {
    if (message.role === 'user') {
      if (message.text.trim() !== '') wire.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      if (flatten || calls.length === 0) {
        const text = [message.text, ...(flatten ? calls.map((call) => `[You asked to use the tool ${call.name} with ${JSON.stringify(call.arguments)}]`) : [])].filter((part) => part.trim() !== '').join('\n');
        if (text !== '') wire.push({ role: 'assistant', content: text });
      } else {
        wire.push({
          role: 'assistant',
          content: message.text,
          tool_calls: calls.map((call): WireToolCall => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
        });
      }
    } else if (flatten) {
      wire.push({ role: 'user', content: `[Result of the tool ${message.name}: ${message.content}]` });
    } else {
      wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    }
  }
  return wire;
}

/** Some models "think aloud" between these tags. That is never said to the caller. */
const THINKING = /<think>[\s\S]*?<\/think>/g;

/**
 * Small models often write a tool request as plain text, for example
 * {"name": "create_staff_task", "parameters": {...}}, instead of using the tool
 * mechanism. When the WHOLE reply is exactly one well-formed request for a tool that
 * was offered in this turn, it is treated as that tool request (the backend still
 * validates it like any other). Anything else, including malformed JSON, is not
 * recovered: it stays text, and the reply checker keeps it from the caller.
 */
export function recoverTextToolCall(text: string, offered: readonly string[]): ModelToolCall | null {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!bare.startsWith('{') || !bare.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bare);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { name, parameters, arguments: args, args: shortArgs } = parsed as Record<string, unknown>;
  if (typeof name !== 'string' || !offered.includes(name)) return null;
  return { id: 'call_text_0', name, arguments: parseArguments(parameters ?? args ?? shortArgs) };
}

/** Reads the answer defensively: anything unexpected is an error or an empty value, never a guess. */
export function fromWire(data: unknown, offeredTools: readonly string[] = []): ModelResponse {
  const choices = typeof data === 'object' && data !== null ? (data as { choices?: unknown }).choices : undefined;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = typeof first === 'object' && first !== null ? (first as { message?: unknown }).message : undefined;
  if (typeof message !== 'object' || message === null) {
    throw new ModelUnavailableError('Ollama sent an unexpected answer');
  }
  const { content, tool_calls: rawCalls } = message as { content?: unknown; tool_calls?: unknown };
  const text = typeof content === 'string' ? content.replace(THINKING, '').trim() : '';

  const toolCalls: ModelToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    for (const [index, raw] of (rawCalls as unknown[]).entries()) {
      const fn = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown; function?: unknown }).function : undefined;
      if (typeof fn !== 'object' || fn === null) continue;
      const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
      if (typeof name !== 'string' || name === '') continue;
      const id = typeof (raw as { id?: unknown }).id === 'string' && (raw as { id: string }).id !== '' ? (raw as { id: string }).id : `call_${index}`;
      toolCalls.push({ id, name, arguments: parseArguments(args) });
    }
  }
  if (toolCalls.length === 0) {
    const recovered = recoverTextToolCall(text, offeredTools);
    if (recovered) return { text: '', toolCalls: [recovered] };
  }
  return { text, toolCalls };
}

/** Arguments arrive as a JSON string (OpenAI style) or already as an object; anything else means "no arguments". */
function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
