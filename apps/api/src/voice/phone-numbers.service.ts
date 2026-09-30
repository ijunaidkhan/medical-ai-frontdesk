import { Inject, Injectable } from '@nestjs/common';
import { PHONE_PATTERN, type PhoneNumberSummary } from '@frontdesk/shared';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { DB, type Db } from '../database/database.module.js';
import { TenantDb } from '../tenancy/tenant-db.js';

@Injectable()
export class PhoneNumbersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tenant: TenantDb,
  ) {}

  /**
   * Which practice owns the number that was dialed? This is the ONLY way a call
   * learns its practice. It returns an id (never anything else), and only when the
   * number is active and its practice is active. Anything that is not a plain
   * international number is refused before it reaches the database.
   */
  async resolvePractice(dialedNumber: string): Promise<string | null> {
    if (!PHONE_PATTERN.test(dialedNumber)) {
      return null;
    }
    const { rows } = await sql<{ practice_id: string | null }>`select resolve_practice_by_number(${dialedNumber}) as practice_id`.execute(this.db);
    return rows[0]?.practice_id ?? null;
  }

  /** The numbers connected to the signed-in practice (row-level security limits it to that practice). */
  listForPractice(auth: AuthContext): Promise<PhoneNumberSummary[]> {
    return this.tenant.run(auth, async (trx) => {
      const rows = await trx.selectFrom('phone_numbers').select(['id', 'e164', 'label', 'active']).orderBy('active', 'desc').orderBy('e164').execute();
      return rows.map((row) => ({ id: row.id, number: row.e164, label: row.label, active: row.active }));
    });
  }
}
