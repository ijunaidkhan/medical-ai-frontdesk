/**
 * The only thing the agent knows about a language model. A vendor adapter
 * implements `LanguageModel`; nothing else in the code base imports a vendor.
 *
 * The model can ask for tools but has no power of its own: the backend decides
 * what a tool does, and everything the model says passes the reply checker.
 */

export interface ModelToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments (an object). */
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  /** Identifies the call so its result can be matched to it. */
  id: string;
  name: string;
  /** Untrusted: whatever the model produced. Always validated before use. */
  arguments: Record<string, unknown>;
}

export type ModelMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ModelToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
}

export interface ModelResponse {
  /** What the model wants to say (may be empty when it only asks for tools). */
  text: string;
  toolCalls: ModelToolCall[];
}

export interface LanguageModel {
  /** Recorded on every conversation, so replies can be compared between models. */
  readonly name: string;
  /** False when no model is set up: conversations cannot start, but fixed safety scripts still work. */
  readonly configured: boolean;
  /** How long one reply may take before the caller gets the fixed safe line. Defaults to 20 seconds; a model running on a laptop needs longer. */
  readonly timeoutMs?: number;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

/** Injection token: the module decides which model is behind it. */
export const LANGUAGE_MODEL = Symbol('LANGUAGE_MODEL');

/**
 * The model could not be reached or is overloaded (network failure, timeout,
 * rate limit, server error). Worth trying again later. The message is written
 * to be safe to log: a status number at most, never anything the vendor sent back.
 */
export class ModelUnavailableError extends Error {
  constructor(message = 'The language model is not available') {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/**
 * The model's API refused the request (for example a wrong key or a bad request).
 * Retrying will not help; an operator has to fix the configuration. Safe-to-log
 * message, as above.
 */
export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

/** The default until an operator chooses a vendor and supplies a key. */
export class UnconfiguredModel implements LanguageModel {
  readonly name = 'unconfigured';
  readonly configured = false;

  complete(): Promise<ModelResponse> {
    return Promise.reject(new ModelUnavailableError('No language model is configured'));
  }
}
