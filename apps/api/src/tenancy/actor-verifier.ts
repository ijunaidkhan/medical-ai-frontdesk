import { Inject, Injectable } from '@nestjs/common';
import { isRole, type Role } from '@frontdesk/shared';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { DB, type Db } from '../database/database.module.js';
import { withPracticeContext } from '../database/practice-context.js';

interface ActorRow {
  role: string;
  membership_status: string;
  practice_status: string;
  user_status: string;
  session_live: boolean;
}

/**
 * Confirms, against the database, that the person behind a valid access token
 * still has access right now. Access tokens are stateless and live for
 * minutes, so without this a logged-out, suspended or demoted user would keep
 * their old powers until the token expired.
 */
@Injectable()
export class ActorVerifier {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The user's CURRENT role, or null if they may no longer act: the session was
   * ended, the membership was suspended or removed, or the user or practice is
   * no longer active.
   */
  async verify(auth: AuthContext): Promise<{ role: Role } | null> {
    const row = await withPracticeContext(this.db, { practiceId: auth.practiceId, userId: auth.userId }, async (trx) => {
      const { rows } = await sql<ActorRow>`
        select m.role,
               m.status as membership_status,
               p.status as practice_status,
               u.status as user_status,
               exists (
                 select 1 from refresh_tokens t
                 where t.family_id = ${auth.sessionId}::uuid
                   and t.user_id = ${auth.userId}::uuid
                   and t.revoked_at is null
                   and t.session_expires_at > now()
               ) as session_live
        from memberships m
        join practices p on p.id = m.practice_id
        join users u on u.id = m.user_id
        where m.user_id = ${auth.userId}::uuid and m.practice_id = ${auth.practiceId}::uuid`.execute(trx);
      return rows[0];
    });

    if (
      !row ||
      !row.session_live ||
      row.membership_status !== 'active' ||
      row.practice_status !== 'active' ||
      row.user_status !== 'active' ||
      !isRole(row.role)
    ) {
      return null;
    }
    return { role: row.role };
  }
}
