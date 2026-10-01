/**
 * Conversations between callers and the AI receptionist. M2a runs them in a
 * text "test chat"; phone calls use the same records later.
 */
export const CONVERSATION_CHANNELS = ['test_chat', 'phone'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

/** active: still going. handed_off: passed to a person (the AI says nothing more). completed: finished. */
export const CONVERSATION_STATUSES = ['active', 'handed_off', 'completed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_OUTCOMES = ['answered', 'message_taken', 'handed_off', 'emergency', 'abandoned'] as const;
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number];

export const CONVERSATION_ESCALATIONS = ['urgent', 'emergency'] as const;
export type ConversationEscalation = (typeof CONVERSATION_ESCALATIONS)[number];

export const TURN_SPEAKERS = ['caller', 'ai', 'system'] as const;
export type TurnSpeaker = (typeof TURN_SPEAKERS)[number];

/** How a line was produced. Fixed safety scripts are marked so reviewers can tell them from the model's own words. */
export const TURN_SOURCES = ['caller', 'greeting', 'model', 'scripted_emergency', 'scripted_urgent', 'scripted_guard', 'scripted_limit', 'system'] as const;
export type TurnSource = (typeof TURN_SOURCES)[number];

export const TOOL_STATUSES = ['ok', 'error', 'rejected'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export const CALLER_MESSAGE_MAX_LENGTH = 2_000;
export const CONVERSATION_PAGE_DEFAULT = 25;
export const CONVERSATION_PAGE_MAX = 100;

export interface ConversationSummary {
  id: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  outcome: ConversationOutcome | null;
  escalation: ConversationEscalation | null;
  turnCount: number;
  startedAt: string;
  endedAt: string | null;
  /** The staff member who ran it (test chats). */
  startedByName: string | null;
  model: string | null;
}

export interface ConversationTurn {
  seq: number;
  speaker: TurnSpeaker;
  source: TurnSource;
  text: string;
  /** Why a reply was replaced by a safe one, when it was. */
  guardReason: string | null;
  /** What the AI model wrote before the safety check replaced it (for reviewers only; the caller never sees it). */
  blockedText: string | null;
  latencyMs: number | null;
  at: string;
}

export interface ConversationToolCall {
  turnSeq: number;
  tool: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: ToolStatus;
  durationMs: number | null;
  at: string;
}

export interface ConversationDetail extends ConversationSummary {
  turns: ConversationTurn[];
  toolCalls: ConversationToolCall[];
  /** The transfer number the call was (or would be) handed to, when there was one. */
  handoffTo: { label: string } | null;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

/** Returned when a test chat starts: the AI's opening line (the practice's greeting plus the AI notice). */
export interface StartConversationResponse {
  conversationId: string;
  greeting: string;
}

export interface SendMessageRequest {
  text: string;
}

/** What the AI said in answer to one message, and what changed because of it. */
export interface AgentReply {
  conversationId: string;
  /** What to show or speak to the caller. */
  reply: string;
  status: ConversationStatus;
  outcome: ConversationOutcome | null;
  escalation: ConversationEscalation | null;
  source: TurnSource;
  /** Tasks the AI created while answering. */
  createdTaskIds: string[];
}
