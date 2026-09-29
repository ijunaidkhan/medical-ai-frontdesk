import { type Kysely, sql, type Transaction } from 'kysely';
import { isUuid } from '../common/uuid.js';
import type { Database } from './database.types.js';

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
  if (!isUuid(context.practiceId)) {
    throw new Error('withPracticeContext: practiceId must be a UUID');
  }
  if (context.userId !== undefined && !isUuid(context.userId)) {
    throw new Error('withPracticeContext: userId must be a UUID');
  }

  return db.transaction().execute(async (trx) => {
    await sql`select
      set_config('app.practice_id', ${context.practiceId}, true),
      set_config('app.user_id', ${context.userId ?? ''}, true)`.execute(trx);
    return work(trx);
  });
}
