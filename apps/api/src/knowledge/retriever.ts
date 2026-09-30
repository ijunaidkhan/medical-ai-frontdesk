import { Injectable } from '@nestjs/common';
import type { KnowledgeSearchResult } from '@frontdesk/shared';
import { type Kysely, sql } from 'kysely';
import type { Database } from '../database/database.types.js';

export const DEFAULT_SEARCH_LIMIT = 5;
const MAX_QUERY_TERMS = 12;

/**
 * Turns a caller's question into a list of plain lowercase words. Only letters
 * and digits survive, so nothing a caller says can act as search syntax.
 * (English only for now: other scripts yield no words and therefore no results.)
 */
export function searchTerms(question: string): string[] {
  const words = question
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .match(/[a-z0-9]{2,}/g);
  return [...new Set(words ?? [])].slice(0, MAX_QUERY_TERMS);
}

interface ChunkRow {
  chunk_id: string;
  source_id: string;
  title: string;
  text: string;
  rank: number;
}

/**
 * Finds approved knowledge that matches a question. Runs inside a practice
 * context, so row-level security limits it to the current practice; it also
 * only looks at chunks whose source is approved. The words are OR-ed together
 * (a natural question rarely repeats the document's exact words) and ranked.
 *
 * This is the only place that reads knowledge for the AI. A future
 * embedding-based retriever would replace this class behind the same method.
 */
@Injectable()
export class KnowledgeRetriever {
  async search(db: Kysely<Database>, question: string, limit = DEFAULT_SEARCH_LIMIT): Promise<KnowledgeSearchResult[]> {
    const terms = searchTerms(question);
    if (terms.length === 0) {
      return [];
    }
    const { rows } = await sql<ChunkRow>`
      select c.id as chunk_id, c.source_id, c.title, c.text, ts_rank_cd(c.tsv, q.query)::float8 as rank
      from knowledge_chunks c
      join knowledge_sources s on s.id = c.source_id and s.status = 'approved'
      cross join to_tsquery('english', ${terms.join(' | ')}) as q(query)
      where c.tsv @@ q.query
      order by rank desc, c.source_id, c.ordinal
      limit ${limit}`.execute(db);
    return rows.map((row) => ({ chunkId: row.chunk_id, sourceId: row.source_id, title: row.title, text: row.text, rank: row.rank }));
  }
}
