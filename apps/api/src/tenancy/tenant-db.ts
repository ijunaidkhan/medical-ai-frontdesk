import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { DB, type Db } from '../database/database.module.js';
import type { Database } from '../database/database.types.js';
import { withPracticeContext } from '../database/practice-context.js';

/**
 * The only way controllers and services should touch tenant data. The
 * practice comes from the verified identity, so a request can never choose
 * another tenant; the database (row-level security) enforces it a second time.
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(DB) private readonly db: Db) {}

  run<T>(auth: AuthContext, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return withPracticeContext(this.db, { practiceId: auth.practiceId, userId: auth.userId }, work);
  }
}
