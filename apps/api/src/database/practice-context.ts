import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database } from './database.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PracticeContext {
  /** The tenant. Must come from a verified credential, never from request input. */
  practiceId: string;
  /** The acting user, when known. */
  userId?: string;
}

/**
 * Runs `work` in a transaction whose row-level-security context is the given
 * practice. Every tenant-owned query in the API must go through this.
 *
 * The setting is transaction-local (set_config(..., true)), so it can never
 * leak to another request that reuses the same pooled connection.
 */
export async function withPracticeContext<T>(
  db: Kysely<Database>,
  context: PracticeContext,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(context.practiceId)) {
    throw new Error('withPracticeContext: practiceId must be a UUID');
  }
  if (context.userId !== undefined && !UUID_PATTERN.test(context.userId)) {
    throw new Error('withPracticeContext: userId must be a UUID');
  }

  return db.transaction().execute(async (trx) => {
    await sql`select
      set_config('app.practice_id', ${context.practiceId}, true),
      set_config('app.user_id', ${context.userId ?? ''}, true)`.execute(trx);
    return work(trx);
  });
}
