import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  type AuthProfile,
  type AuthSession,
  isRole,
  type LoginRequest,
  type PracticeSummary,
} from '@frontdesk/shared';
import { type Kysely, sql } from 'kysely';
import { PinoLogger } from 'nestjs-pino';
import { writeAuditLog } from '../audit/audit-log.js';
import type { RequestMeta } from '../common/request-meta.js';
import { DB, type Db } from '../database/database.module.js';
import type { Database } from '../database/database.types.js';
import { withPracticeContext } from '../database/practice-context.js';
import { AccessTokenService } from './access-token.service.js';
import type { AuthContext } from './auth-context.js';
import { REFRESH_REUSE_GRACE_SECONDS, REFRESH_TOKEN_IDLE_TTL_SECONDS, SESSION_MAX_SECONDS } from './auth.constants.js';
import { PasswordHasher } from './password-hasher.js';
import { createRefreshToken, parseRefreshToken } from './refresh-token.js';

/** One message for every credential problem, so responses reveal nothing about which accounts exist. */
const INVALID_CREDENTIALS = 'Invalid email or password';

export interface IssuedSession {
  session: AuthSession;
  /** Goes into the httpOnly cookie, never into the response body. */
  refreshToken: string;
  refreshExpiresAt: Date;
}

export type RefreshResult =
  | ({ ok: true } & IssuedSession)
  /**
   * `clearCookie` is false for the benign two-tabs race: the winning request
   * already replaced the cookie, and clearing it here could erase that.
   */
  | { ok: false; clearCookie: boolean };

type LoginFailureReason =
  | 'unknown_email'
  | 'invalid_password'
  | 'account_locked'
  | 'account_disabled'
  | 'no_active_practice'
  | 'practice_not_permitted';

interface UserLookupRow {
  id: string;
  password_hash: string;
  status: string;
  is_locked: boolean;
}

interface PracticeRow {
  practice_id: string;
  name: string;
  slug: string;
  timezone: string;
  role: string;
}

/** A short non-reversible fingerprint, so repeated attempts can be correlated without storing the email. */
function fingerprint(value: string): string {
  return createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 16);
}

const seconds = (value: number) => sql`make_interval(secs => ${value}::double precision)`;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hasher: PasswordHasher,
    private readonly tokens: AccessTokenService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  // ------------------------------------------------------------------ login

  async login(input: LoginRequest, meta: RequestMeta): Promise<IssuedSession> {
    const email = input.email.trim();
    const user = await this.findUserByEmail(email);

    // Always verify against *some* hash, so an unknown email costs the same
    // time as a wrong password.
    const passwordOk = await this.hasher.verify(user?.password_hash ?? (await this.hasher.dummyHash()), input.password);

    if (!user || !passwordOk) {
      const failure = await this.recordLoginFailure(user?.id ?? null);
      await this.auditLoginFailure(user?.id ?? null, email, user ? 'invalid_password' : 'unknown_email', meta);
      if (failure?.locked_until) {
        await writeAuditLog(this.db, {
          practiceId: null,
          actorUserId: user?.id ?? null,
          action: 'auth.account.locked',
          requestId: meta.requestId,
          ip: meta.ip,
          metadata: { lockedUntil: failure.locked_until.toISOString(), failedAttempts: failure.failed_login_count },
        });
      }
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Correct password from here on. A locked or disabled account is still refused.
    if (user.is_locked) {
      await this.auditLoginFailure(user.id, email, 'account_locked', meta);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (user.status !== 'active') {
      await this.auditLoginFailure(user.id, email, 'account_disabled', meta);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const practices = await this.listPractices(user.id);
    const chosen = input.practiceId ? practices.find((p) => p.practice_id === input.practiceId) : practices[0];
    if (!chosen) {
      await this.auditLoginFailure(
        user.id,
        email,
        practices.length === 0 ? 'no_active_practice' : 'practice_not_permitted',
        meta,
      );
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    await sql`select auth_record_login_success(${user.id})`.execute(this.db);

    const issued = await withPracticeContext(this.db, { practiceId: chosen.practice_id, userId: user.id }, async (trx) => {
      const profile = await this.loadProfile(trx, user.id, chosen.practice_id);
      if (!profile) {
        return null;
      }
      const familyId = randomUUID();
      const stored = await this.insertRefreshToken(trx, {
        userId: user.id,
        practiceId: chosen.practice_id,
        familyId,
        sessionEnd: null,
        meta,
      });
      await writeAuditLog(trx, {
        practiceId: chosen.practice_id,
        actorUserId: user.id,
        action: 'auth.login.success',
        requestId: meta.requestId,
        ip: meta.ip,
        metadata: { sessionId: familyId },
      });
      return { profile, familyId, ...stored };
    });

    if (!issued) {
      // The membership or practice went inactive between the two lookups.
      await this.auditLoginFailure(user.id, email, 'no_active_practice', meta);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return {
      session: await this.buildSession(issued.profile, issued.familyId),
      refreshToken: issued.value,
      refreshExpiresAt: issued.expiresAt,
    };
  }

  // ---------------------------------------------------------------- refresh

  /**
   * Exchanges a refresh token for a new access token and a new refresh token
   * (rotation). Presenting an already-rotated token after the short grace
   * window is treated as theft and ends the whole session.
   */
  async refresh(rawToken: unknown, meta: RequestMeta): Promise<RefreshResult> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) {
      return { ok: false, clearCookie: true };
    }

    // A revocation must commit even though the request is refused, so the
    // transaction returns a verdict instead of throwing.
    const outcome = await withPracticeContext(this.db, { practiceId: parsed.practiceId }, async (trx) => {
      const row = await trx
        .selectFrom('refresh_tokens')
        .selectAll()
        .select([
          sql<boolean>`expires_at <= now() OR session_expires_at <= now()`.as('is_expired'),
          sql<number | null>`extract(epoch from (now() - revoked_at))::float8`.as('revoked_age_seconds'),
        ])
        .where('token_hash', '=', parsed.hash)
        .forUpdate() // serialises concurrent refreshes of the same token
        .executeTakeFirst();

      if (!row) {
        return { kind: 'unknown' as const };
      }

      if (row.revoked_at !== null) {
        const wasRotated = row.replaced_by_id !== null;
        const withinGrace =
          wasRotated && row.revoked_age_seconds !== null && row.revoked_age_seconds <= REFRESH_REUSE_GRACE_SECONDS;
        if (withinGrace) {
          return { kind: 'race' as const };
        }
        if (wasRotated) {
          await this.revokeFamily(trx, row.family_id);
          await writeAuditLog(trx, {
            practiceId: parsed.practiceId,
            actorUserId: row.user_id,
            action: 'auth.refresh.reuse_detected',
            requestId: meta.requestId,
            ip: meta.ip,
            metadata: { sessionId: row.family_id },
          });
          return { kind: 'reuse' as const };
        }
        return { kind: 'revoked' as const }; // ended by logout or an earlier revocation
      }

      if (row.is_expired) {
        return { kind: 'expired' as const };
      }

      const profile = await this.loadProfile(trx, row.user_id, parsed.practiceId);
      if (!profile) {
        // The user, membership or practice was disabled: end the session.
        await this.revokeFamily(trx, row.family_id);
        await writeAuditLog(trx, {
          practiceId: parsed.practiceId,
          actorUserId: row.user_id,
          action: 'auth.refresh.denied',
          requestId: meta.requestId,
          ip: meta.ip,
          metadata: { sessionId: row.family_id, reason: 'access_removed' },
        });
        return { kind: 'denied' as const };
      }

      const next = await this.insertRefreshToken(trx, {
        userId: row.user_id,
        practiceId: parsed.practiceId,
        familyId: row.family_id,
        sessionEnd: row.session_expires_at,
        meta,
      });
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: sql<Date>`now()`, replaced_by_id: next.id })
        .where('id', '=', row.id)
        .execute();

      return { kind: 'rotated' as const, profile, familyId: row.family_id, next };
    });

    if (outcome.kind !== 'rotated') {
      this.logger.info({ event: 'refresh_rejected', reason: outcome.kind }, 'Refresh token rejected');
      return { ok: false, clearCookie: outcome.kind !== 'race' };
    }

    return {
      ok: true,
      session: await this.buildSession(outcome.profile, outcome.familyId),
      refreshToken: outcome.next.value,
      refreshExpiresAt: outcome.next.expiresAt,
    };
  }

  // ----------------------------------------------------------------- logout

  /** Ends the session the token belongs to. Idempotent: unknown or missing tokens are ignored. */
  async logout(rawToken: unknown, meta: RequestMeta): Promise<void> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) {
      return;
    }
    await withPracticeContext(this.db, { practiceId: parsed.practiceId }, async (trx) => {
      const row = await trx
        .selectFrom('refresh_tokens')
        .select(['family_id', 'user_id'])
        .where('token_hash', '=', parsed.hash)
        .executeTakeFirst();
      if (!row) {
        return;
      }
      await this.revokeFamily(trx, row.family_id);
      await writeAuditLog(trx, {
        practiceId: parsed.practiceId,
        actorUserId: row.user_id,
        action: 'auth.logout',
        requestId: meta.requestId,
        ip: meta.ip,
        metadata: { sessionId: row.family_id },
      });
    });
  }

  // ------------------------------------------------------- switch practice

  /**
   * Moves the signed-in user to another practice they belong to: a brand-new
   * session in the target tenant, and the current one ends. The session's
   * absolute end time carries over, so switching cannot extend a login.
   */
  async switchPractice(auth: AuthContext, targetPracticeId: string, meta: RequestMeta): Promise<IssuedSession> {
    if (targetPracticeId === auth.practiceId) {
      throw new BadRequestException('Already signed in to that practice');
    }

    // The bearer token alone is not enough: the session behind it must still be live.
    const current = await withPracticeContext(this.db, { practiceId: auth.practiceId, userId: auth.userId }, (trx) =>
      trx
        .selectFrom('refresh_tokens')
        .select('session_expires_at')
        .where('family_id', '=', auth.sessionId)
        .where('user_id', '=', auth.userId)
        .where('revoked_at', 'is', null)
        .where(sql<boolean>`session_expires_at > now()`)
        .executeTakeFirst(),
    );
    if (!current) {
      throw new UnauthorizedException('Session has ended');
    }

    const permitted = (await this.listPractices(auth.userId)).some((p) => p.practice_id === targetPracticeId);
    if (!permitted) {
      // Same answer whether the practice does not exist or the user is not a member.
      throw new ForbiddenException('You do not have access to that practice');
    }

    const issued = await withPracticeContext(this.db, { practiceId: targetPracticeId, userId: auth.userId }, async (trx) => {
      const profile = await this.loadProfile(trx, auth.userId, targetPracticeId);
      if (!profile) {
        return null;
      }
      const familyId = randomUUID();
      const stored = await this.insertRefreshToken(trx, {
        userId: auth.userId,
        practiceId: targetPracticeId,
        familyId,
        sessionEnd: current.session_expires_at,
        meta,
      });
      await writeAuditLog(trx, {
        practiceId: targetPracticeId,
        actorUserId: auth.userId,
        action: 'auth.practice.switched',
        requestId: meta.requestId,
        ip: meta.ip,
        metadata: { sessionId: familyId, fromPracticeId: auth.practiceId },
      });
      return { profile, familyId, ...stored };
    });
    if (!issued) {
      throw new ForbiddenException('You do not have access to that practice');
    }

    await withPracticeContext(this.db, { practiceId: auth.practiceId, userId: auth.userId }, (trx) =>
      this.revokeFamily(trx, auth.sessionId),
    );

    return {
      session: await this.buildSession(issued.profile, issued.familyId),
      refreshToken: issued.value,
      refreshExpiresAt: issued.expiresAt,
    };
  }

  // ---------------------------------------------------------------- profile

  /** Current identity from the database (not just the token), so removed access is noticed. */
  async getProfile(auth: AuthContext): Promise<AuthProfile> {
    const profile = await withPracticeContext(this.db, { practiceId: auth.practiceId, userId: auth.userId }, (trx) =>
      this.loadProfile(trx, auth.userId, auth.practiceId),
    );
    if (!profile) {
      throw new UnauthorizedException('Access to this practice has ended');
    }
    return profile;
  }

  // ---------------------------------------------------------------- helpers

  private async findUserByEmail(email: string): Promise<UserLookupRow | undefined> {
    const { rows } = await sql<UserLookupRow>`select * from auth_find_user_by_email(${email})`.execute(this.db);
    return rows[0];
  }

  private async recordLoginFailure(
    userId: string | null,
  ): Promise<{ failed_login_count: number; locked_until: Date | null } | undefined> {
    // Called for unknown emails too (with NULL, which updates nothing) so both cases do the same work.
    const { rows } = await sql<{ failed_login_count: number; locked_until: Date | null }>`
      select * from auth_record_login_failure(${userId}::uuid)`.execute(this.db);
    return rows[0];
  }

  private async listPractices(userId: string): Promise<PracticeRow[]> {
    const { rows } = await sql<PracticeRow>`select * from auth_list_user_practices(${userId}::uuid)`.execute(this.db);
    return rows;
  }

  private auditLoginFailure(
    userId: string | null,
    email: string,
    reason: LoginFailureReason,
    meta: RequestMeta,
  ): Promise<void> {
    return writeAuditLog(this.db, {
      practiceId: null,
      actorUserId: userId,
      action: 'auth.login.failed',
      requestId: meta.requestId,
      ip: meta.ip,
      // The email is fingerprinted, not stored: people sometimes type their password into the email field.
      metadata: { reason, emailFingerprint: fingerprint(email) },
    });
  }

  private async revokeFamily(trx: Kysely<Database>, familyId: string): Promise<void> {
    await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: sql<Date>`now()` })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  private async insertRefreshToken(
    trx: Kysely<Database>,
    params: {
      userId: string;
      practiceId: string;
      familyId: string;
      /** The session's absolute end; null starts a new session (now + SESSION_MAX_SECONDS). */
      sessionEnd: Date | null;
      meta: RequestMeta;
    },
  ): Promise<{ id: string; value: string; expiresAt: Date }> {
    const token = createRefreshToken(params.practiceId);
    const sessionEnd = params.sessionEnd ?? sql<Date>`now() + ${seconds(SESSION_MAX_SECONDS)}`;
    const row = await trx
      .insertInto('refresh_tokens')
      .values({
        user_id: params.userId,
        practice_id: params.practiceId,
        family_id: params.familyId,
        token_hash: token.hash,
        // Idle timeout, but never beyond the session's absolute end.
        expires_at: sql<Date>`least(now() + ${seconds(REFRESH_TOKEN_IDLE_TTL_SECONDS)}, ${sessionEnd})`,
        session_expires_at: sessionEnd,
        revoked_at: null,
        replaced_by_id: null,
        created_ip: params.meta.ip,
        user_agent: params.meta.userAgent,
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();
    return { id: row.id, value: token.value, expiresAt: row.expires_at };
  }

  /** The user, the practice and their role in it. Null unless all three are active. */
  private async loadProfile(trx: Kysely<Database>, userId: string, practiceId: string): Promise<AuthProfile | null> {
    const [user, practice, membership] = await Promise.all([
      trx.selectFrom('users').select(['id', 'email', 'display_name', 'status']).where('id', '=', userId).executeTakeFirst(),
      trx
        .selectFrom('practices')
        .select(['id', 'name', 'slug', 'timezone', 'status'])
        .where('id', '=', practiceId)
        .executeTakeFirst(),
      trx
        .selectFrom('memberships')
        .select(['role', 'status'])
        .where('user_id', '=', userId)
        .where('practice_id', '=', practiceId)
        .executeTakeFirst(),
    ]);
    if (
      !user ||
      !practice ||
      !membership ||
      user.status !== 'active' ||
      practice.status !== 'active' ||
      membership.status !== 'active' ||
      !isRole(membership.role)
    ) {
      return null;
    }

    const practices: PracticeSummary[] = (await this.listPractices(userId)).flatMap((p) =>
      isRole(p.role) ? [{ id: p.practice_id, name: p.name, slug: p.slug, timezone: p.timezone, role: p.role }] : [],
    );

    return {
      user: { id: user.id, email: user.email, displayName: user.display_name },
      practice: { id: practice.id, name: practice.name, slug: practice.slug, timezone: practice.timezone, role: membership.role },
      practices,
    };
  }

  private async buildSession(profile: AuthProfile, sessionId: string): Promise<AuthSession> {
    const { token, expiresAt } = await this.tokens.sign({
      userId: profile.user.id,
      practiceId: profile.practice.id,
      role: profile.practice.role,
      sessionId,
    });
    return { ...profile, accessToken: token, accessTokenExpiresAt: expiresAt.toISOString() };
  }
}
