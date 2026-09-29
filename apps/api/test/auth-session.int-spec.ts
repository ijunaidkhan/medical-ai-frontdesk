import { decodeJwt } from 'jose';
import { sql } from 'kysely';
import type { Db } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import {
  cookieValue,
  isCleared,
  logoutRequest,
  meRequest,
  refreshRequest,
  setCookieLine,
  signIn,
  switchRequest,
  type TestApp,
} from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

describe('sessions: refresh, logout and switching practice', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;

  const tokensOf = (familyId: string) =>
    owner.selectFrom('refresh_tokens').selectAll().where('family_id', '=', familyId).orderBy('created_at').execute();

  const audit = (action: string) => owner.selectFrom('audit_logs').selectAll().where('action', '=', action).execute();

  const familyOf = (accessToken: string) => decodeJwt(accessToken)['sid'] as string;

  /** A fresh member of alpha with the given role, so tests never disturb each other's state. */
  let memberCounter = 0;
  async function newMember(role: 'admin' | 'staff' | 'viewer' = 'staff') {
    const email = `member${++memberCounter}@alpha.test`;
    const userId = await addMember(owner, alpha.practiceId, email, role);
    return { email, userId };
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  describe('refresh', () => {
    it('exchanges the cookie for a new access token and a new cookie (rotation)', async () => {
      const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });

      const res = await refreshRequest(app, cookie).expect(200);
      const newCookie = cookieValue(res);

      expect(newCookie).toBeDefined();
      expect(newCookie).not.toBe(cookie);
      // (Access tokens issued in the same second with the same claims are identical, so they are not compared.)
      expect(res.body.user.id).toBe(alpha.ownerId);
      expect(familyOf(res.body.accessToken)).toBe(familyOf(session.accessToken));
      expect(JSON.stringify(res.body)).not.toContain(newCookie!);

      const rows = await tokensOf(familyOf(session.accessToken));
      expect(rows).toHaveLength(2);
      expect(rows[0]!.revoked_at).toBeInstanceOf(Date);
      expect(rows[0]!.replaced_by_id).toBe(rows[1]!.id);
      expect(rows[1]!.revoked_at).toBeNull();
      expect(rows[1]!.session_expires_at.getTime()).toBe(rows[0]!.session_expires_at.getTime());
    });

    it('stores only a hash of the token', async () => {
      const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });
      const [row] = await tokensOf(familyOf(session.accessToken));
      expect(row!.token_hash).toHaveLength(32);
      expect(row!.token_hash.toString('utf8')).not.toContain(cookie.split('.')[1]!.slice(0, 20));
    });

    it('can be chained many times', async () => {
      let { cookie } = await signIn(app, { email: alpha.ownerEmail });
      for (let i = 0; i < 4; i++) {
        const res = await refreshRequest(app, cookie).expect(200);
        cookie = cookieValue(res)!;
        // Wait out the reuse-grace window is unnecessary: each token is used exactly once.
      }
    });

    describe('CSRF protection (Origin check)', () => {
      it.each([
        ['no Origin header', null],
        ['a foreign origin', 'https://evil.example'],
        ['the literal "null" origin', 'null'],
        ['a look-alike origin', 'http://localhost:4200.evil.example'],
      ])('refuses %s even with a valid cookie', async (_label, origin) => {
        const { cookie } = await signIn(app, { email: alpha.ownerEmail });
        const res = await refreshRequest(app, cookie, { origin }).expect(403);
        expect(cookieValue(res)).toBeUndefined();
        // The valid cookie was not consumed by the refused request.
        await refreshRequest(app, cookie).expect(200);
      });
    });

    describe('refuses', () => {
      it('a request with no cookie, and clears any stale one', async () => {
        const res = await refreshRequest(app, undefined).expect(401);
        expect(isCleared(res)).toBe(true);
      });

      it.each(['garbage', 'not-a-uuid.' + 'A'.repeat(43), "x'; drop table refresh_tokens; --"])(
        'a malformed cookie: %s',
        async (value) => {
          const res = await refreshRequest(app, value).expect(401);
          expect(isCleared(res)).toBe(true);
        },
      );

      it('a well-formed token that was never issued', async () => {
        const forged = `${alpha.practiceId}.${'A'.repeat(43)}`;
        await refreshRequest(app, forged).expect(401);
      });

      it('a real token with its practice id edited to another tenant', async () => {
        const { cookie } = await signIn(app, { email: alpha.ownerEmail });
        const secret = cookie.split('.')[1]!;
        await refreshRequest(app, `${beta.practiceId}.${secret}`).expect(401);
        await refreshRequest(app, cookie).expect(200); // the genuine token is unaffected
      });

      it('an idle token (unused for over 30 minutes)', async () => {
        const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });
        await owner.updateTable('refresh_tokens').set({ expires_at: sql`now() - interval '1 second'` }).where('family_id', '=', familyOf(session.accessToken)).execute();
        const res = await refreshRequest(app, cookie).expect(401);
        expect(isCleared(res)).toBe(true);
      });

      it('a session past its 12-hour limit, however recently it was used', async () => {
        const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });
        await owner
          .updateTable('refresh_tokens')
          .set({ session_expires_at: sql`now() - interval '1 second'`, expires_at: sql`now() - interval '1 second'` })
          .where('family_id', '=', familyOf(session.accessToken))
          .execute();
        await refreshRequest(app, cookie).expect(401);
      });
    });

    it('never extends a session beyond its absolute end', async () => {
      const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });
      const family = familyOf(session.accessToken);
      // Pretend the session is 5 minutes from its 12-hour limit.
      await owner
        .updateTable('refresh_tokens')
        .set({ session_expires_at: sql`now() + interval '5 minutes'`, expires_at: sql`now() + interval '5 minutes'` })
        .where('family_id', '=', family)
        .execute();

      await refreshRequest(app, cookie).expect(200);

      const latest = (await tokensOf(family)).at(-1)!;
      expect(latest.expires_at.getTime()).toBeLessThanOrEqual(latest.session_expires_at.getTime());
      expect(latest.expires_at.getTime() - Date.now()).toBeLessThan(6 * 60_000); // not the usual 30 minutes
    });

    describe('reuse of an old token', () => {
      it('is tolerated for a moment (two browser tabs refreshing at once) without ending the session or touching the cookie', async () => {
        const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });
        const winner = await refreshRequest(app, cookie).expect(200);
        const newCookie = cookieValue(winner)!;

        const loser = await refreshRequest(app, cookie).expect(401);
        expect(setCookieLine(loser)).toBeUndefined(); // must not clear the winner's fresh cookie

        await refreshRequest(app, newCookie).expect(200); // the session lives on
        expect((await audit('auth.refresh.reuse_detected')).filter((r) => (r.metadata as { sessionId: string }).sessionId === familyOf(session.accessToken))).toHaveLength(0);
      });

      it('is treated as theft after the grace period: the whole session ends, for the thief and the victim', async () => {
        const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });
        const family = familyOf(session.accessToken);
        const victimCookie = cookieValue(await refreshRequest(app, cookie).expect(200))!;

        // The stolen (already rotated) token is replayed a minute later.
        await owner
          .updateTable('refresh_tokens')
          .set({ revoked_at: sql`now() - interval '60 seconds'` })
          .where('family_id', '=', family)
          .where('replaced_by_id', 'is not', null)
          .execute();
        const replay = await refreshRequest(app, cookie).expect(401);
        expect(isCleared(replay)).toBe(true);

        // Everyone holding a token from this session is now signed out.
        await refreshRequest(app, victimCookie).expect(401);
        const rows = await tokensOf(family);
        expect(rows.every((r) => r.revoked_at !== null)).toBe(true);

        const detected = (await audit('auth.refresh.reuse_detected')).find((r) => (r.metadata as { sessionId: string }).sessionId === family);
        expect(detected).toMatchObject({ practice_id: alpha.practiceId, actor_user_id: alpha.ownerId });
      });

      it('does not touch other sessions of the same user', async () => {
        const first = await signIn(app, { email: alpha.ownerEmail });
        const second = await signIn(app, { email: alpha.ownerEmail });
        const rotated = cookieValue(await refreshRequest(app, first.cookie).expect(200))!;
        await owner.updateTable('refresh_tokens').set({ revoked_at: sql`now() - interval '60 seconds'` }).where('family_id', '=', familyOf(first.session.accessToken)).where('replaced_by_id', 'is not', null).execute();

        await refreshRequest(app, first.cookie).expect(401); // theft on session one
        await refreshRequest(app, rotated).expect(401);
        await refreshRequest(app, second.cookie).expect(200); // session two is unaffected
      });
    });

    describe('when the user loses access', () => {
      const expectSessionEnded = async (cookie: string, family: string, reason: string) => {
        const res = await refreshRequest(app, cookie).expect(401);
        expect(isCleared(res)).toBe(true);
        expect((await tokensOf(family)).every((r) => r.revoked_at !== null)).toBe(true);
        const denied = (await audit('auth.refresh.denied')).find((r) => (r.metadata as { sessionId: string }).sessionId === family);
        expect(denied?.metadata).toMatchObject({ reason });
      };

      it('ends the session when the membership is suspended', async () => {
        const { email, userId } = await newMember();
        const { session, cookie } = await signIn(app, { email });
        await owner.updateTable('memberships').set({ status: 'suspended' }).where('user_id', '=', userId).execute();
        await expectSessionEnded(cookie, familyOf(session.accessToken), 'access_removed');
      });

      it('ends the session when the user is disabled', async () => {
        const { email, userId } = await newMember();
        const { session, cookie } = await signIn(app, { email });
        await owner.updateTable('users').set({ status: 'disabled' }).where('id', '=', userId).execute();
        await expectSessionEnded(cookie, familyOf(session.accessToken), 'access_removed');
      });

      it('ends the session when the membership is deleted', async () => {
        const { email, userId } = await newMember();
        const { session, cookie } = await signIn(app, { email });
        await owner.deleteFrom('memberships').where('user_id', '=', userId).execute();
        await expectSessionEnded(cookie, familyOf(session.accessToken), 'access_removed');
      });

      it('applies a role change at the next refresh', async () => {
        const { email, userId } = await newMember('viewer');
        const { session, cookie } = await signIn(app, { email });
        expect(decodeJwt(session.accessToken)['role']).toBe('viewer');

        await owner.updateTable('memberships').set({ role: 'admin' }).where('user_id', '=', userId).execute();
        const res = await refreshRequest(app, cookie).expect(200);

        expect(res.body.practice.role).toBe('admin');
        expect(decodeJwt(res.body.accessToken)['role']).toBe('admin');
      });
    });
  });

  describe('logout', () => {
    it('ends the session: the cookie stops working and every token in the session is revoked', async () => {
      const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });
      const rotated = cookieValue(await refreshRequest(app, cookie).expect(200))!;

      const res = await logoutRequest(app, rotated).expect(204);
      expect(isCleared(res)).toBe(true);

      await refreshRequest(app, rotated).expect(401);
      expect((await tokensOf(familyOf(session.accessToken))).every((r) => r.revoked_at !== null)).toBe(true);
      const entry = (await audit('auth.logout')).find((r) => (r.metadata as { sessionId: string }).sessionId === familyOf(session.accessToken));
      expect(entry).toMatchObject({ practice_id: alpha.practiceId, actor_user_id: alpha.ownerId });
    });

    it('only ends its own session', async () => {
      const first = await signIn(app, { email: alpha.ownerEmail });
      const second = await signIn(app, { email: alpha.ownerEmail });
      await logoutRequest(app, first.cookie).expect(204);
      await refreshRequest(app, second.cookie).expect(200);
    });

    it('succeeds quietly with no cookie, an unknown cookie, or one used twice', async () => {
      await logoutRequest(app, undefined).expect(204);
      await logoutRequest(app, `${alpha.practiceId}.${'B'.repeat(43)}`).expect(204);
      const { cookie } = await signIn(app, { email: alpha.ownerEmail });
      await logoutRequest(app, cookie).expect(204);
      await logoutRequest(app, cookie).expect(204);
    });

    it('requires an allowed Origin, so another site cannot log a user out', async () => {
      const { cookie } = await signIn(app, { email: alpha.ownerEmail });
      await logoutRequest(app, cookie, { origin: 'https://evil.example' }).expect(403);
      await logoutRequest(app, cookie, { origin: null }).expect(403);
      await refreshRequest(app, cookie).expect(200); // still signed in
    });

    it('documents a known limit: an access token already issued stays valid until it expires (at most 10 minutes)', async () => {
      const { session, cookie } = await signIn(app, { email: alpha.ownerEmail });
      await logoutRequest(app, cookie).expect(204);
      await meRequest(app, session.accessToken).expect(200);
    });
  });

  describe('switching practice', () => {
    let multiEmail: string;
    let multiId: string;

    beforeAll(async () => {
      multiEmail = 'multi@example.test';
      multiId = await addMember(owner, alpha.practiceId, multiEmail, 'viewer');
      await owner.insertInto('memberships').values({ practice_id: beta.practiceId, user_id: multiId, role: 'admin' }).execute();
    });

    it('lists every practice the user can use, and signs in to the first by name', async () => {
      const { session } = await signIn(app, { email: multiEmail });
      expect(session.practice.slug).toBe('alpha');
      expect(session.practice.role).toBe('viewer');
      expect(session.practices.map((p) => [p.slug, p.role])).toEqual([
        ['alpha', 'viewer'],
        ['beta', 'admin'],
      ]);
    });

    it('lets the user choose the practice at login', async () => {
      const { session } = await signIn(app, { email: multiEmail, practiceId: beta.practiceId });
      expect(session.practice.slug).toBe('beta');
      expect(session.practice.role).toBe('admin');
    });

    it('moves to the other practice with that practice’s role, a new cookie, and ends the old session', async () => {
      const { session, cookie } = await signIn(app, { email: multiEmail });

      const res = await switchRequest(app, session.accessToken, beta.practiceId).expect(200);
      const newCookie = cookieValue(res)!;

      expect(res.body.practice).toMatchObject({ id: beta.practiceId, slug: 'beta', role: 'admin' });
      expect(decodeJwt(res.body.accessToken)).toMatchObject({ pid: beta.practiceId, role: 'admin', sub: multiId });
      expect(newCookie.startsWith(`${beta.practiceId}.`)).toBe(true);
      expect(familyOf(res.body.accessToken)).not.toBe(familyOf(session.accessToken));

      await refreshRequest(app, cookie).expect(401); // the alpha session is over
      await refreshRequest(app, newCookie).expect(200); // the beta session works

      const entry = (await audit('auth.practice.switched')).find((r) => r.practice_id === beta.practiceId && r.actor_user_id === multiId);
      expect(entry?.metadata).toMatchObject({ fromPracticeId: alpha.practiceId });
    });

    it('carries over the session’s absolute end, so switching cannot extend a login', async () => {
      const { session } = await signIn(app, { email: multiEmail });
      const before = (await tokensOf(familyOf(session.accessToken)))[0]!;

      const res = await switchRequest(app, session.accessToken, beta.practiceId).expect(200);
      const after = (await tokensOf(familyOf(res.body.accessToken)))[0]!;

      expect(after.session_expires_at.getTime()).toBe(before.session_expires_at.getTime());
      expect(after.practice_id).toBe(beta.practiceId);
    });

    it('acts in the new practice only: /me reflects it', async () => {
      const { session } = await signIn(app, { email: multiEmail });
      const switched = await switchRequest(app, session.accessToken, beta.practiceId).expect(200);
      const me = await meRequest(app, switched.body.accessToken).expect(200);
      expect(me.body.practice.slug).toBe('beta');
      expect(me.body.practice.role).toBe('admin');
    });

    describe('refuses', () => {
      it('a practice the user does not belong to, with the same answer as one that does not exist', async () => {
        const { email } = await newMember();
        const { session } = await signIn(app, { email });

        const foreign = await switchRequest(app, session.accessToken, beta.practiceId).expect(403);
        const missing = await switchRequest(app, session.accessToken, '0190ffff-0000-7000-8000-000000000000').expect(403);
        const { requestId: _a, ...foreignBody } = foreign.body as Record<string, unknown>;
        const { requestId: _b, ...missingBody } = missing.body as Record<string, unknown>;
        expect(foreignBody).toEqual(missingBody);
      });

      it('a practice the user is suspended in', async () => {
        const email = 'suspended-in-beta@example.test';
        const userId = await addMember(owner, alpha.practiceId, email, 'staff');
        await owner.insertInto('memberships').values({ practice_id: beta.practiceId, user_id: userId, role: 'staff', status: 'suspended' }).execute();
        const { session } = await signIn(app, { email });
        await switchRequest(app, session.accessToken, beta.practiceId).expect(403);
      });

      it('the practice the user is already in', async () => {
        const { session } = await signIn(app, { email: multiEmail });
        await switchRequest(app, session.accessToken, alpha.practiceId).expect(400);
      });

      it.each([['not-a-uuid'], [42], [undefined]])('an invalid practice id: %s', async (bad) => {
        const { session } = await signIn(app, { email: multiEmail });
        await switchRequest(app, session.accessToken, bad).expect(400);
      });

      it('a request without an access token', async () => {
        await switchRequest(app, 'not-a-token', beta.practiceId).expect(401);
      });

      it('a valid access token whose session has been ended', async () => {
        const { session, cookie } = await signIn(app, { email: multiEmail });
        await logoutRequest(app, cookie).expect(204);
        await meRequest(app, session.accessToken).expect(200); // the token itself is still valid...
        await switchRequest(app, session.accessToken, beta.practiceId).expect(401); // ...but cannot start a new session
      });
    });
  });
});
