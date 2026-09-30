/**
 * The clinic's approved information that the AI receptionist may use to answer
 * callers. Staff write it, and only an approved version can ever be used.
 */
export const KNOWLEDGE_CATEGORIES = ['general', 'hours_location', 'services', 'insurance_billing', 'policies', 'faq'] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const KNOWLEDGE_STATUSES = ['draft', 'approved', 'archived'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_TITLE_MAX_LENGTH = 200;
export const KNOWLEDGE_CONTENT_MAX_LENGTH = 20_000;
export const KNOWLEDGE_SEARCH_MAX_LENGTH = 300;

export interface KnowledgeSourceSummary {
  id: string;
  title: string;
  category: KnowledgeCategory;
  status: KnowledgeStatus;
  /** Increases every time the title or content changes. */
  version: number;
  /** The first characters of the content, for lists. */
  excerpt: string;
  updatedAt: string;
  approvedAt: string | null;
  approvedByName: string | null;
}

export interface KnowledgeSourceDetail extends KnowledgeSourceSummary {
  content: string;
}

export interface CreateKnowledgeRequest {
  title: string;
  category: KnowledgeCategory;
  content: string;
}

/**
 * Only the fields present are changed. Changing the title or content of an
 * approved source sends it back to draft: new wording must be approved again.
 */
export interface UpdateKnowledgeRequest {
  title?: string;
  category?: KnowledgeCategory;
  content?: string;
}

export interface KnowledgeSearchResult {
  chunkId: string;
  sourceId: string;
  title: string;
  text: string;
  /** Higher is a better match. Only meaningful for comparing results of one search. */
  rank: number;
}
