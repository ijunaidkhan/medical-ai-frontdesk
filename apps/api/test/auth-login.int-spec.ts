import { decodeJwt } from 'jose';
import { sql } from 'kysely';
import request from 'supertest';
import type { Db } from '../src/database/database.module.js';
import { PasswordHasher } from '../src/auth/password-hasher.js';
import { startTestApp } from './support/app.js';
import {
  cookieValue,
  GENERIC_LOGIN_ERROR,
  loginRequest,
  meRequest,
  setCookieLine,
  type TestApp,
  uniqueIp,
} from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice, TEST_PASSWORD } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

describe('login and identity', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;

  const lockState = async (email: string) =>
    owner.selectFrom('users').select(['failed_login_count', 'locked_until']).where('email', '=', email).executeTakeFirstOrThrow();

  const auditActions = async (action: string) =>
    owner.selectFrom('audit_logs').selectAll().where('action', '=', action).orderBy('occurred_at').execute();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    await addMember(owner, alpha.practiceId, 'staff@alpha.test', 'staff');
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    await owner.updateTable('users').set({ failed_login_count: 0, locked_until: null }).execute();
  });

  describe('successful login', () => {
    it('returns the session, sets the refresh cookie, and keeps the refresh token out of the body', async () => {
      const res = await loginRequest(app, { email: alpha.ownerEmail }).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'accessTokenExpiresAt', 'practice', 'practices', 'user']);
      expect(res.body.user).toEqual({ id: alpha.ownerId, email: alpha.ownerEmail, displayName: 'Owner of alpha' });
      expect(res.body.practice).toMatchObject({ id: alpha.practiceId, slug: 'alpha', role: 'owner', timezone: 'UTC' });
      expect(res.body.practices).toHaveLength(1);

      const expiresIn = new Date(res.body.accessTokenExpiresAt).getTime() - Date.now();
      expect(expiresIn).toBeGreaterThan(9 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(10 * 60_000);

      const cookie = cookieValue(res);
      expect(cookie).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(res.body)).not.toContain(cookie!);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('sets a cookie that scripts cannot read, other sites cannot trigger, and only auth routes receive', async () => {
      const line = setCookieLine(await loginRequest(app, { email: alpha.ownerEmail }).expect(200))!;
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/SameSite=Strict/i);
      expect(line).toMatch(/Path=\/api\/auth(;|$)/);
      expect(line).toMatch(/Expires=/i);
    });

    it('issues an access token carrying only user, practice, role and session', async () => {
      const res = await loginRequest(app, { email: alpha.ownerEmail }).expect(200);
      const claims = decodeJwt(res.body.accessToken);
      expect(claims.sub).toBe(alpha.ownerId);
      expect(claims['pid']).toBe(alpha.practiceId);
      expect(claims['role']).toBe('owner');
      expect(claims['sid']).toMatch(/^[0-9a-f-]{36}$/);
      expect(claims.exp! - claims.iat!).toBe(600);
    });

    it('matches the email case-insensitively', async () => {
      await loginRequest(app, { email: alpha.ownerEmail.toUpperCase() }).expect(200);
    });

    it('lets a member sign in with their own role', async () => {
      const res = await loginRequest(app, { email: 'staff@alpha.test' }).expect(200);
      expect(res.body.practice.role).toBe('staff');
    });

    it('resets the failed-attempt counter and records the last login', async () => {
      await owner.updateTable('users').set({ failed_login_count: 3 }).where('email', '=', alpha.ownerEmail).execute();
      await loginRequest(app, { email: alpha.ownerEmail }).expect(200);
      const user = await owner
        .selectFrom('users')
        .select(['failed_login_count', 'locked_until', 'last_login_at'])
        .where('email', '=', alpha.ownerEmail)
        .executeTakeFirstOrThrow();
      expect(user.failed_login_count).toBe(0);
      expect(user.last_login_at).toBeInstanceOf(Date);
    });

    it('records the sign-in in the audit log with client details but no secrets', async () => {
      const ip = uniqueIp();
      const before = (await auditActions('auth.login.success')).length;
      await loginRequest(app, { email: alpha.ownerEmail }, ip).expect(200);

      const rows = await auditActions('auth.login.success');
      expect(rows).toHaveLength(before + 1);
      const row = rows.at(-1)!;
      expect(row).toMatchObject({ practice_id: alpha.practiceId, actor_user_id: alpha.ownerId, ip });
      expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(row)).not.toContain(TEST_PASSWORD);
    });

    it('creates a session that expires after 12 hours and idles out after 30 minutes', async () => {
      await loginRequest(app, { email: alpha.ownerEmail }).expect(200);
      const { rows } = await sql<{ idle_min: number; session_hours: number }>`
        select extract(epoch from (expires_at - created_at)) / 60 as idle_min,
               extract(epoch from (session_expires_at - created_at)) / 3600 as session_hours
        from refresh_tokens order by created_at desc limit 1`.execute(owner);
      expect(Math.round(rows[0]!.idle_min)).toBe(30);
      expect(Math.round(rows[0]!.session_hours)).toBe(12);
    });
  });

  describe('failed login', () => {
    const failures = async () => {
      const suspended = await seedPractice(owner, 'gamma', 'owner@gamma.test');
      await owner.updateTable('practices').set({ status: 'suspended' }).where('id', '=', suspended.practiceId).execute();
      await owner
        .insertInto('users')
        .values({
          email: 'disabled@alpha.test',
          password_hash: await new PasswordHasher().hash(TEST_PASSWORD),
          display_name: 'Disabled',
          status: 'disabled',
          locked_until: null,
          last_login_at: null,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await owner
        .insertInto('users')
        .values({
          email: 'orphan@nowhere.test',
          password_hash: await new PasswordHasher().hash(TEST_PASSWORD),
          display_name: 'No practice',
          locked_until: null,
          last_login_at: null,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return [
        ['wrong password', { email: alpha.ownerEmail, password: 'not the right password' }],
        ['unknown email', { email: 'nobody@alpha.test' }],
        ['disabled account', { email: 'disabled@alpha.test' }],
        ['account with no practice', { email: 'orphan@nowhere.test' }],
        ['account whose only practice is suspended', { email: suspended.ownerEmail }],
        ['practice the user does not belong to', { email: alpha.ownerEmail, practiceId: suspended.practiceId }],
      ] as const;
    };

    it('answers every kind of failure identically, so nothing reveals which accounts exist', async () => {
      const cases = await failures();
      const bodies: unknown[] = [];
      for (const [, credentials] of cases) {
        const res = await loginRequest(app, credentials).expect(401);
        expect(setCookieLine(res)).toBeUndefined();
        const { requestId, ...body } = res.body as Record<string, unknown>;
        expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
        bodies.push(body);
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(bodies[0]).toEqual({ statusCode: 401, error: 'unauthorized', message: GENERIC_LOGIN_ERROR });
    });

    it('still verifies a password when the email is unknown, so timing does not reveal it', async () => {
      const verify = vi.spyOn(PasswordHasher.prototype, 'verify');
      try {
        await loginRequest(app, { email: 'nobody@alpha.test' }).expect(401);
        expect(verify).toHaveBeenCalledTimes(1);
      } finally {
        verify.mockRestore();
      }
    });

    it('records failures in the audit log with a reason and an email fingerprint, never the email or password', async () => {
      const typedPasswordIntoEmailField = 'hunter2-oops@alpha.test';
      await loginRequest(app, { email: typedPasswordIntoEmailField, password: 'another wrong password' }).expect(401);
      await loginRequest(app, { email: alpha.ownerEmail, password: 'not the right password' }).expect(401);

      const rows = await auditActions('auth.login.failed');
      const unknown = rows.find((r) => (r.metadata as { reason: string }).reason === 'unknown_email')!;
      const wrong = rows.find((r) => (r.metadata as { reason: string }).reason === 'invalid_password')!;

      expect(unknown.actor_user_id).toBeNull();
      expect(unknown.practice_id).toBeNull();
      expect(wrong.actor_user_id).toBe(alpha.ownerId);
      for (const row of [unknown, wrong]) {
        const serialised = JSON.stringify(row);
        expect(serialised).not.toContain('hunter2');
        expect(serialised).not.toContain('another wrong password');
        expect(serialised).not.toContain('not the right password');
        expect(serialised).not.toContain(alpha.ownerEmail);
        expect((row.metadata as { emailFingerprint: string }).emailFingerprint).toMatch(/^[0-9a-f]{16}$/);
      }
    });
  });

  describe('input validation', () => {
    const post = (body: unknown) =>
      request(app.getHttpServer()).post('/api/auth/login').set('X-Forwarded-For', uniqueIp()).send(body as object);

    it.each([
      ['missing password', { email: 'a@b.test' }],
      ['missing email', { password: TEST_PASSWORD }],
      ['malformed email', { email: 'not-an-email', password: TEST_PASSWORD }],
      ['email over 254 characters', { email: `${'a'.repeat(250)}@b.test`, password: TEST_PASSWORD }],
      ['empty password', { email: 'a@b.test', password: '' }],
      ['password over 128 characters', { email: 'a@b.test', password: 'p'.repeat(129) }],
      ['password that is not a string', { email: 'a@b.test', password: 12345 }],
      ['unknown extra field', { email: 'a@b.test', password: TEST_PASSWORD, isAdmin: true }],
      ['practiceId that is not a uuid', { email: 'a@b.test', password: TEST_PASSWORD, practiceId: "1' OR '1'='1" }],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await post(body).expect(400);
      expect(res.body.statusCode).toBe(400);
    });

    it('rejects a body that is not JSON', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .set('Content-Type', 'application/json')
        .send('{"email": ')
        .expect(400);
    });
  });

  describe('account lockout', () => {
    const attempt = (email: string, password = 'definitely the wrong password') => loginRequest(app, { email, password });

    it('locks the account after 5 wrong passwords, even for the correct password, then recovers', async () => {
      for (let i = 1; i <= 4; i++) {
        await attempt(alpha.ownerEmail).expect(401);
        expect((await lockState(alpha.ownerEmail)).locked_until).toBeNull();
      }
      await attempt(alpha.ownerEmail).expect(401); // 5th
      const locked = await lockState(alpha.ownerEmail);
      expect(locked.failed_login_count).toBe(5);
      expect(locked.locked_until!.getTime() - Date.now()).toBeGreaterThan(50_000);
      expect(locked.locked_until!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);

      // The right password is refused while locked, with the same generic answer.
      const refused = await loginRequest(app, { email: alpha.ownerEmail }).expect(401);
      expect(refused.body.message).toBe(GENERIC_LOGIN_ERROR);
      expect(setCookieLine(refused)).toBeUndefined();
      expect((await auditActions('auth.login.failed')).some((r) => (r.metadata as { reason: string }).reason === 'account_locked')).toBe(true);
      expect((await auditActions('auth.account.locked')).length).toBeGreaterThan(0);

      // Attempts during the lock neither extend it nor count.
      await attempt(alpha.ownerEmail).expect(401);
      const still = await lockState(alpha.ownerEmail);
      expect(still.failed_login_count).toBe(5);
      expect(still.locked_until!.getTime()).toBe(locked.locked_until!.getTime());

      // After the lock expires the correct password works and the counter resets.
      await owner.updateTable('users').set({ locked_until: sql`now() - interval '1 second'` }).where('email', '=', alpha.ownerEmail).execute();
      await loginRequest(app, { email: alpha.ownerEmail }).expect(200);
      expect(await lockState(alpha.ownerEmail)).toMatchObject({ failed_login_count: 0, locked_until: null });
    });

    it('doubles the lock time with each further failure after it expires', async () => {
      await owner
        .updateTable('users')
        .set({ failed_login_count: 5, locked_until: sql`now() - interval '1 second'` })
        .where('email', '=', alpha.ownerEmail)
        .execute();

      await attempt(alpha.ownerEmail).expect(401); // 6th failure -> 2 minutes
      const second = await lockState(alpha.ownerEmail);
      expect(second.failed_login_count).toBe(6);
      const remaining = second.locked_until!.getTime() - Date.now();
      expect(remaining).toBeGreaterThan(110_000);
      expect(remaining).toBeLessThanOrEqual(120_000);
    });

    it('caps the lock at one hour', async () => {
      await owner
        .updateTable('users')
        .set({ failed_login_count: 40, locked_until: sql`now() - interval '1 second'` })
        .where('email', '=', alpha.ownerEmail)
        .execute();
      await attempt(alpha.ownerEmail).expect(401);
      const remaining = (await lockState(alpha.ownerEmail)).locked_until!.getTime() - Date.now();
      expect(remaining).toBeGreaterThan(59 * 60_000);
      expect(remaining).toBeLessThanOrEqual(60 * 60_000);
    });

    it('does not lock other accounts, and unknown emails never create lock state', async () => {
      for (let i = 0; i < 5; i++) {
        await attempt(alpha.ownerEmail).expect(401);
        await attempt('nobody@alpha.test').expect(401);
      }
      await loginRequest(app, { email: 'staff@alpha.test' }).expect(200);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the current identity from the database', async () => {
      const login = await loginRequest(app, { email: alpha.ownerEmail }).expect(200);
      const res = await meRequest(app, login.body.accessToken).expect(200);
      expect(res.body).toEqual({ user: login.body.user, practice: login.body.practice, practices: login.body.practices });
    });

    it('notices when access to the practice has been removed, without waiting for the token to expire', async () => {
      const login = await loginRequest(app, { email: 'staff@alpha.test' }).expect(200);
      await meRequest(app, login.body.accessToken).expect(200);

      await owner.updateTable('memberships').set({ status: 'suspended' }).where('practice_id', '=', alpha.practiceId).where('role', '=', 'staff').execute();
      try {
        await meRequest(app, login.body.accessToken).expect(401);
      } finally {
        await owner.updateTable('memberships').set({ status: 'active' }).where('practice_id', '=', alpha.practiceId).execute();
      }
    });

    it('reports a role change immediately, even though the token still says the old role', async () => {
      const login = await loginRequest(app, { email: 'staff@alpha.test' }).expect(200);
      await owner.updateTable('memberships').set({ role: 'admin' }).where('practice_id', '=', alpha.practiceId).where('role', '=', 'staff').execute();
      try {
        const res = await meRequest(app, login.body.accessToken).expect(200);
        expect(res.body.practice.role).toBe('admin');
        expect(decodeJwt(login.body.accessToken)['role']).toBe('staff');
      } finally {
        await owner.updateTable('memberships').set({ role: 'staff' }).where('practice_id', '=', alpha.practiceId).where('user_id', '=', (await owner.selectFrom('users').select('id').where('email', '=', 'staff@alpha.test').executeTakeFirstOrThrow()).id).execute();
      }
    });
  });
});
