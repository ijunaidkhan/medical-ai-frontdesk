import {
  ModelRequestError,
  ModelUnavailableError,
  type LanguageModel,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
} from './language-model.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
/** Replies are a few short sentences (they may be read aloud), so this is generous. */
const DEFAULT_MAX_OUTPUT_TOKENS = 500;

export interface AnthropicModelOptions {
  /** A secret. Held only in memory; never logged, never put in an error message. */
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  /** For tests only: the production wiring never sets these, so the key can only ever go to api.anthropic.com. */
  fetch?: typeof fetch;
  baseUrl?: string;
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };
interface WireMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

/**
 * Claude through Anthropic's Messages API, behind the provider-neutral
 * `LanguageModel` interface. It only translates: what the model may do, what is
 * checked and what is stored are decided elsewhere. No SDK dependency: one
 * HTTPS call made with the platform's fetch.
 *
 * What is sent to Anthropic: the system instructions (including the practice's
 * name), the conversation so far, and tool results (for example approved
 * knowledge text). Nothing else, and never a practice id.
 */
export class AnthropicModel implements LanguageModel {
  readonly configured = true;
  readonly name: string;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(private readonly options: AnthropicModelOptions) {
    this.name = `anthropic:${options.model}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.url = options.baseUrl ?? API_URL;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const { system, messages } = toWire(request);
    const body: Record<string, unknown> = {
      model: this.options.model,
      max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      system,
      messages,
    };
    if (request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.options.apiKey, 'anthropic-version': API_VERSION },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      // Network failure or abort. The underlying error is not passed on: it could describe the request.
      throw new ModelUnavailableError('Could not reach the model API');
    }

    if (!response.ok) {
      // Overloaded, rate limited or a server problem: try again later. Anything else is a configuration problem.
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      throw retryable
        ? new ModelUnavailableError(`The model API answered ${response.status}`)
        : new ModelRequestError(`The model API refused the request (${response.status})`, response.status);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ModelUnavailableError('The model API sent an unreadable answer');
    }
    return fromWire(data);
  }
}

// ------------------------------------------------------------------ translation

/**
 * Converts our neutral messages to Anthropic's format:
 *  - the conversation must start with the caller, so anything the AI said first
 *    (the greeting) moves into the system text;
 *  - a tool call and its result become tool_use / tool_result blocks;
 *  - when no tools are offered, tool blocks are written as plain text (the API
 *    rejects tool blocks without tool definitions);
 *  - consecutive messages from one side are merged, and nothing empty is sent.
 */
export function toWire(request: ModelRequest): { system: string; messages: WireMessage[] } {
  const flatten = request.tools.length === 0;
  const messages = [...request.messages];

  const greeted: string[] = [];
  while (messages[0]?.role === 'assistant') {
    const first = messages.shift() as Extract<ModelMessage, { role: 'assistant' }>;
    if (first.text.trim() !== '') greeted.push(first.text.trim());
  }
  const system = greeted.length > 0 ? `${request.system}\n\nYou have already said this to the caller: ${greeted.join(' ')}` : request.system;

  const wire: WireMessage[] = [];
  const push = (role: WireMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = wire.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else wire.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === 'user') {
      push('user', message.text.trim() === '' ? [] : [{ type: 'text', text: message.text }]);
    } else if (message.role === 'assistant') {
      const blocks: Block[] = [];
      if (message.text.trim() !== '') blocks.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls ?? []) {
        blocks.push(flatten ? { type: 'text', text: `[You asked to use the tool ${call.name} with ${JSON.stringify(call.arguments)}]` } : { type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      push('assistant', blocks);
    } else {
      push('user', [flatten ? { type: 'text', text: `[Result of the tool ${message.name}: ${message.content}]` } : { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]);
    }
  }

  // A tool_result must come before any other content in its message.
  for (const message of wire) {
    message.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  }
  return { system, messages: wire };
}

/** Reads Anthropic's answer defensively: anything unexpected is an error, never a guess. */
export function fromWire(data: unknown): ModelResponse {
  const content = typeof data === 'object' && data !== null ? (data as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) {
    throw new ModelUnavailableError('The model API sent an unexpected answer');
  }
  let text = '';
  const toolCalls: ModelToolCall[] = [];
  for (const block of content as unknown[]) {
    if (typeof block !== 'object' || block === null) continue;
    const { type, text: blockText, id, name, input } = block as Record<string, unknown>;
    if (type === 'text' && typeof blockText === 'string') {
      text += blockText;
    } else if (type === 'tool_use' && typeof id === 'string' && typeof name === 'string') {
      toolCalls.push({ id, name, arguments: typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {} });
    }
  }
  return { text, toolCalls };
}
