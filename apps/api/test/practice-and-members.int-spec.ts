import type { MemberSummary, PracticeDetails, Role } from '@frontdesk/shared';
import type { Db } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import { as, cookieValue, loginRequest, refreshRequest, signIn, switchRequest, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const ROLE_LIST: Role[] = ['owner', 'admin', 'staff', 'viewer'];
/** For test tables, which are built before beforeAll has created any real ids. */
const SOME_UUID = '0190ffff-0000-7000-8000-000000000000';

describe('practice, members and access control through the API', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  /** Signed-in access tokens for one user of each role in alpha. */
  const token: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  const userId: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  let betaStaffId: string;

  let counter = 0;
  /** A brand-new alpha member, so mutation tests never disturb each other. */
  async function newMember(role: Role = 'staff') {
    const email = `fresh${++counter}@alpha.test`;
    const id = await addMember(owner, alpha.practiceId, email, role);
    return { email, id };
  }

  const roleOf = async (id: string, practiceId = alpha.practiceId) =>
    (await owner.selectFrom('memberships').select(['role', 'status']).where('user_id', '=', id).where('practice_id', '=', practiceId).executeTakeFirstOrThrow());

  const audit = (action: string, practiceId = alpha.practiceId) =>
    owner.selectFrom('audit_logs').selectAll().where('action', '=', action).where('practice_id', '=', practiceId).orderBy('occurred_at').execute();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    userId.owner = alpha.ownerId;
    userId.admin = await addMember(owner, alpha.practiceId, 'admin@alpha.test', 'admin');
    userId.staff = await addMember(owner, alpha.practiceId, 'staff@alpha.test', 'staff');
    userId.viewer = await addMember(owner, alpha.practiceId, 'viewer@alpha.test', 'viewer');
    betaStaffId = await addMember(owner, beta.practiceId, 'staff@beta.test', 'staff');
    app = await startTestApp();

    const emails: Record<Role, string> = { owner: alpha.ownerEmail, admin: 'admin@alpha.test', staff: 'staff@alpha.test', viewer: 'viewer@alpha.test' };
    for (const role of ROLE_LIST) {
      token[role] = (await signIn(app, { email: emails[role] })).session.accessToken;
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  describe('permissions by role', () => {
    it.each(ROLE_LIST)('GET /api/practice as %s', async (role) => {
      await as(app, token[role]).get('/api/practice').expect(200);
    });

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 403], ['viewer', 403]])(
      'PATCH /api/practice as %s -> %i',
      async (role, status) => {
        await as(app, token[role]).patch('/api/practice', { timezone: 'UTC' }).expect(status);
      },
    );

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])(
      'GET /api/members as %s -> %i',
      async (role, status) => {
        await as(app, token[role]).get('/api/members').expect(status);
      },
    );

    it.each<[Role, number]>([['owner', 400], ['admin', 400], ['staff', 403], ['viewer', 403]])(
      'PATCH /api/members/:id as %s -> %i (400 = permitted, but the request changes nothing)',
      async (role, status) => {
        await as(app, token[role]).patch(`/api/members/${userId.viewer}`, { role: 'viewer' }).expect(status);
      },
    );

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 403], ['viewer', 403]])(
      'GET /api/audit-logs as %s -> %i',
      async (role, status) => {
        await as(app, token[role]).get('/api/audit-logs').expect(status);
      },
    );

    it.each([
      ['GET', '/api/practice'],
      ['PATCH', '/api/practice'],
      ['GET', '/api/members'],
      ['PATCH', `/api/members/${'0190a1b2-c3d4-7e5f-8a9b-000000000001'}`],
      ['GET', '/api/audit-logs'],
    ])('%s %s needs a login', async (method, path) => {
      const res = await as(app, 'not-a-token')[method === 'GET' ? 'get' : 'patch'](path).expect(401);
      expect(res.body.statusCode).toBe(401);
    });
  });

  describe('tenant isolation (a signed-in user sees only their own practice)', () => {
    it('returns the caller’s own practice', async () => {
      const res = await as(app, token.admin).get('/api/practice').expect(200);
      expect(res.body).toMatchObject({ id: alpha.practiceId, slug: 'alpha' });
    });

    it('lists only the caller’s own members', async () => {
      const res = await as(app, token.admin).get('/api/members').expect(200);
      const emails = (res.body as MemberSummary[]).map((m) => m.email);
      expect(emails).toContain('staff@alpha.test');
      expect(emails).not.toContain('staff@beta.test');
      expect(emails).not.toContain(beta.ownerEmail);
    });

    it('shows only the caller’s own practice’s audit trail', async () => {
      const res = await as(app, token.owner).get('/api/audit-logs?limit=200').expect(200);
      const serialised = JSON.stringify(res.body);
      expect(serialised).toContain('bootstrap.practice_created');
      expect(serialised).toContain('"slug":"alpha"');
      expect(serialised).not.toContain('"slug":"beta"');
      expect(serialised).not.toContain(beta.ownerId);
    });

    it('cannot reach another practice’s member: it is simply not found, and nothing changes', async () => {
      const res = await as(app, token.owner).patch(`/api/members/${betaStaffId}`, { role: 'viewer' }).expect(404);
      expect(res.body.message).toBe('Member not found');
      expect(await roleOf(betaStaffId, beta.practiceId)).toEqual({ role: 'staff', status: 'active' });
    });

    it('cannot be tricked into another practice by a value in the body, the URL or a header', async () => {
      // A body field naming another practice is rejected outright.
      await as(app, token.owner).patch('/api/practice', { practiceId: beta.practiceId, name: 'Hijacked' }).expect(400);
      // Query and header values are ignored: the practice always comes from the verified token.
      const viaQuery = await as(app, token.owner).get(`/api/practice?practiceId=${beta.practiceId}`).expect(200);
      const viaHeader = await as(app, token.owner).get('/api/practice').set('X-Practice-Id', beta.practiceId).expect(200);
      expect(viaQuery.body.slug).toBe('alpha');
      expect(viaHeader.body.slug).toBe('alpha');
      await as(app, token.owner).get(`/api/audit-logs?practiceId=${beta.practiceId}`).expect(400);
      expect((await owner.selectFrom('practices').select('name').where('id', '=', beta.practiceId).executeTakeFirstOrThrow()).name).toBe('Practice beta');
    });

    it('follows the user when they switch practice, and no data comes along', async () => {
      const email = 'traveller@example.test';
      const id = await addMember(owner, alpha.practiceId, email, 'admin');
      await owner.insertInto('memberships').values({ practice_id: beta.practiceId, user_id: id, role: 'viewer' }).execute();

      const inAlpha = await signIn(app, { email });
      expect((await as(app, inAlpha.session.accessToken).get('/api/practice').expect(200)).body.slug).toBe('alpha');
      await as(app, inAlpha.session.accessToken).get('/api/audit-logs').expect(200);

      const switched = await switchRequest(app, inAlpha.session.accessToken, beta.practiceId).expect(200);
      const inBeta = switched.body.accessToken as string;
      expect((await as(app, inBeta).get('/api/practice').expect(200)).body.slug).toBe('beta');
      // In beta this user is only a viewer: alpha's admin powers do not follow them.
      await as(app, inBeta).get('/api/audit-logs').expect(403);
      await as(app, inBeta).get('/api/members').expect(403);
      // The old alpha token no longer works: that session ended when they switched.
      await as(app, inAlpha.session.accessToken).get('/api/practice').expect(401);
    });
  });

  describe('editing the practice', () => {
    it('updates name, time zone and phone, and records what was changed', async () => {
      const res = await as(app, token.owner)
        .patch('/api/practice', { name: '  Alpha Family Clinic  ', timezone: 'America/New_York', phone: '+14155550123' })
        .expect(200);
      const practice = res.body as PracticeDetails;
      expect(practice).toMatchObject({ name: 'Alpha Family Clinic', timezone: 'America/New_York', phone: '+14155550123', slug: 'alpha', status: 'active' });
      expect((await as(app, token.staff).get('/api/practice').expect(200)).body).toEqual(practice);

      const entry = (await audit('practice.updated')).at(-1)!;
      expect(entry).toMatchObject({ actor_user_id: alpha.ownerId, target_id: alpha.practiceId });
      expect(entry.metadata).toEqual({ fields: ['name', 'timezone', 'phone'] });
      expect(JSON.stringify(entry.metadata)).not.toContain('+1415');
    });

    it('changes only the fields sent, and null clears the phone number', async () => {
      await as(app, token.admin).patch('/api/practice', { phone: '+14155550123' }).expect(200);
      const partial = await as(app, token.admin).patch('/api/practice', { timezone: 'Asia/Karachi' }).expect(200);
      expect(partial.body).toMatchObject({ timezone: 'Asia/Karachi', phone: '+14155550123', name: 'Alpha Family Clinic' });
      const cleared = await as(app, token.admin).patch('/api/practice', { phone: null }).expect(200);
      expect(cleared.body.phone).toBeNull();
    });

    it.each([
      ['an empty request', {}],
      ['a blank name', { name: '   ' }],
      ['a null name', { name: null }],
      ['a name over 120 characters', { name: 'n'.repeat(121) }],
      ['a name that is not text', { name: 42 }],
      ['an unknown time zone', { timezone: 'Mars/Olympus' }],
      ['a null time zone', { timezone: null }],
      ['a phone without a country code', { phone: '415-555-0123' }],
      ['a phone that is too short', { phone: '+123' }],
      ['the short name (cannot be changed)', { slug: 'stolen' }],
      ['the status (cannot be changed)', { status: 'suspended' }],
      ['the id (cannot be changed)', { id: SOME_UUID }],
    ])('rejects %s', async (_label, body) => {
      await as(app, token.owner).patch('/api/practice', body).expect(400);
      const now = await owner.selectFrom('practices').select(['slug', 'status']).where('id', '=', alpha.practiceId).executeTakeFirstOrThrow();
      expect(now).toEqual({ slug: 'alpha', status: 'active' });
    });

    it('is refused for staff and viewers, and changes nothing', async () => {
      const before = (await as(app, token.owner).get('/api/practice').expect(200)).body;
      await as(app, token.staff).patch('/api/practice', { name: 'Vandalised' }).expect(403);
      await as(app, token.viewer).patch('/api/practice', { name: 'Vandalised' }).expect(403);
      expect((await as(app, token.owner).get('/api/practice').expect(200)).body).toEqual(before);
    });
  });

  describe('managing members', () => {
    it('lets an owner change a role, ends that member’s sessions, and records it', async () => {
      const { email, id } = await newMember('staff');
      const session = await signIn(app, { email });

      const res = await as(app, token.owner).patch(`/api/members/${id}`, { role: 'admin' }).expect(200);
      expect(res.body).toMatchObject({ userId: id, email, role: 'admin', status: 'active' });

      await refreshRequest(app, session.cookie).expect(401);
      await as(app, session.session.accessToken).get('/api/practice').expect(401);
      const entry = (await audit('member.role_changed')).at(-1)!;
      expect(entry).toMatchObject({ actor_user_id: alpha.ownerId, target_id: id });
      expect(entry.metadata).toEqual({ from: 'staff', to: 'admin' });

      // Signing in again gives them the new role.
      expect((await signIn(app, { email })).session.practice.role).toBe('admin');
    });

    it('suspends a member at once, and lets them back in when reactivated', async () => {
      const { email, id } = await newMember('staff');
      const session = await signIn(app, { email });
      await as(app, session.session.accessToken).get('/api/practice').expect(200);

      await as(app, token.owner).patch(`/api/members/${id}`, { status: 'suspended' }).expect(200);

      // Everything they held stops working immediately, including a not-yet-expired access token.
      await as(app, session.session.accessToken).get('/api/practice').expect(401);
      await refreshRequest(app, session.cookie).expect(401);
      const denied = await loginRequest(app, { email }).expect(401);
      expect(denied.body.message).toBe('Invalid email or password');
      expect(cookieValue(denied)).toBeUndefined();
      expect((await audit('member.suspended')).at(-1)).toMatchObject({ target_id: id, actor_user_id: alpha.ownerId });

      await as(app, token.owner).patch(`/api/members/${id}`, { status: 'active' }).expect(200);
      await signIn(app, { email });
      expect((await audit('member.reactivated')).at(-1)).toMatchObject({ target_id: id });
    });

    it('records both events when a role and a status change together', async () => {
      const { id } = await newMember('viewer');
      await as(app, token.owner).patch(`/api/members/${id}`, { role: 'staff', status: 'suspended' }).expect(200);
      expect((await audit('member.role_changed')).some((e) => e.target_id === id)).toBe(true);
      expect((await audit('member.suspended')).some((e) => e.target_id === id)).toBe(true);
    });

    describe('what an admin may and may not do', () => {
      it.each<Role>(['staff', 'viewer'])('may suspend and reactivate a %s', async (role) => {
        const { id } = await newMember(role);
        await as(app, token.admin).patch(`/api/members/${id}`, { status: 'suspended' }).expect(200);
        await as(app, token.admin).patch(`/api/members/${id}`, { status: 'active' }).expect(200);
      });

      it('may move staff and viewers between those two roles', async () => {
        const { id } = await newMember('staff');
        await as(app, token.admin).patch(`/api/members/${id}`, { role: 'viewer' }).expect(200);
        await as(app, token.admin).patch(`/api/members/${id}`, { role: 'staff' }).expect(200);
      });

      it.each<Role>(['admin', 'owner'])('may NOT make someone a %s', async (role) => {
        const { id } = await newMember('staff');
        const res = await as(app, token.admin).patch(`/api/members/${id}`, { role }).expect(403);
        expect(res.body.message).toMatch(/Only an owner/);
        expect((await roleOf(id)).role).toBe('staff');
      });

      it('may NOT change or suspend another admin, or an owner', async () => {
        const { id: otherAdmin } = await newMember('admin');
        for (const target of [otherAdmin, userId.owner]) {
          await as(app, token.admin).patch(`/api/members/${target}`, { status: 'suspended' }).expect(403);
          await as(app, token.admin).patch(`/api/members/${target}`, { role: 'viewer' }).expect(403);
        }
        expect((await roleOf(otherAdmin)).status).toBe('active');
        expect((await roleOf(userId.owner)).status).toBe('active');
      });
    });

    it('never lets anyone change themselves', async () => {
      for (const role of ['owner', 'admin'] as const) {
        const res = await as(app, token[role]).patch(`/api/members/${userId[role]}`, { role: 'viewer' }).expect(403);
        expect(res.body.message).toMatch(/your own/);
        await as(app, token[role]).patch(`/api/members/${userId[role]}`, { status: 'suspended' }).expect(403);
      }
    });

    it.each([
      ['an unknown role', { role: 'superadmin' }],
      ['a role of the wrong type', { role: 7 }],
      ['an unknown status', { status: 'banned' }],
      ['null role', { role: null }],
      ['an unknown field', { role: 'viewer', practiceId: SOME_UUID }],
      ['an attempt to rewrite the email', { role: 'viewer', email: 'x@y.test' }],
    ])('rejects %s', async (_label, body) => {
      const { id } = await newMember('staff');
      await as(app, token.owner).patch(`/api/members/${id}`, body).expect(400);
      expect(await roleOf(id)).toEqual({ role: 'staff', status: 'active' });
    });

    it('answers 400 for an id that is not a UUID and 404 for one that does not exist', async () => {
      await as(app, token.owner).patch('/api/members/not-a-uuid', { role: 'viewer' }).expect(400);
      await as(app, token.owner).patch('/api/members/0190ffff-0000-7000-8000-000000000000', { role: 'viewer' }).expect(404);
    });

    it('applies a demotion made behind the API’s back the moment it happens (the database role wins over the token)', async () => {
      const { email, id } = await newMember('admin');
      const session = await signIn(app, { email });
      await as(app, session.session.accessToken).get('/api/audit-logs').expect(200); // admin today

      await owner.updateTable('memberships').set({ role: 'viewer' }).where('user_id', '=', id).execute();

      // The token still says "admin" and the session is still live, but the current role is viewer.
      await as(app, session.session.accessToken).get('/api/audit-logs').expect(403);
      await as(app, session.session.accessToken).get('/api/practice').expect(200);
    });

    it('applies the database role to the business rules too, not just to the permission check', async () => {
      // Someone who WAS an owner keeps a live session and a token saying "owner", then is demoted to admin
      // directly in the database (so no session is ended).
      const { email, id } = await newMember('owner');
      const session = await signIn(app, { email });
      const { id: target } = await newMember('staff');
      await owner.updateTable('memberships').set({ role: 'admin' }).where('user_id', '=', id).execute();

      // As an owner they could make staff an admin; as the admin they now are, they may not.
      const res = await as(app, session.session.accessToken).patch(`/api/members/${target}`, { role: 'admin' }).expect(403);
      expect(res.body.message).toMatch(/Only an owner/);
      expect((await roleOf(target)).role).toBe('staff');
    });

    describe('access removed directly in the database (the session itself is still alive)', () => {
      const removals: Array<[string, (userId: string, practiceId: string) => Promise<unknown>]> = [
        ['the membership is suspended', (u, p) => owner.updateTable('memberships').set({ status: 'suspended' }).where('user_id', '=', u).where('practice_id', '=', p).execute()],
        ['the membership is deleted', (u, p) => owner.deleteFrom('memberships').where('user_id', '=', u).where('practice_id', '=', p).execute()],
        ['the user account is disabled', (u) => owner.updateTable('users').set({ status: 'disabled' }).where('id', '=', u).execute()],
        ['the practice is suspended', (_u, p) => owner.updateTable('practices').set({ status: 'suspended' }).where('id', '=', p).execute()],
      ];

      it.each(removals)('is refused at once when %s', async (_label, remove) => {
        const email = `removal${++counter}@alpha.test`;
        // Its own practice, so suspending or emptying it cannot disturb other tests.
        const own = await seedPractice(owner, `removal-${counter}`, `boss${counter}@example.test`);
        const memberId = await addMember(owner, own.practiceId, email, 'admin');
        const session = await signIn(app, { email });
        await as(app, session.session.accessToken).get('/api/practice').expect(200);

        await remove(memberId, own.practiceId);

        const res = await as(app, session.session.accessToken).get('/api/practice').expect(401);
        expect(res.body.message).toBe('Access to this practice has ended');
      });
    });

    describe('a practice always keeps an owner', () => {
      it('turns two owners demoting each other at once into one success and one refusal', async () => {
        // A separate practice, so this cannot disturb the other tests.
        const duel = await seedPractice(owner, 'duel', 'first@duel.test');
        const secondId = await addMember(owner, duel.practiceId, 'second@duel.test', 'owner');
        const first = await signIn(app, { email: 'first@duel.test' });
        const second = await signIn(app, { email: 'second@duel.test' });

        const results = await Promise.all([
          as(app, first.session.accessToken).patch(`/api/members/${secondId}`, { role: 'admin' }),
          as(app, second.session.accessToken).patch(`/api/members/${duel.ownerId}`, { role: 'admin' }),
        ]);

        const statuses = results.map((r) => r.status).sort();
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        expect(statuses.filter((s) => s !== 200)).toHaveLength(1);
        expect(statuses.find((s) => s !== 200)).toBeOneOf([401, 409]);

        const owners = await owner
          .selectFrom('memberships')
          .select('user_id')
          .where('practice_id', '=', duel.practiceId)
          .where('role', '=', 'owner')
          .where('status', '=', 'active')
          .execute();
        expect(owners).toHaveLength(1);
      });
    });

    it('lists members with their roles, without any credential fields', async () => {
      const res = await as(app, token.staff).get('/api/members').expect(200);
      const members = res.body as MemberSummary[];
      expect(members.length).toBeGreaterThanOrEqual(4);
      for (const member of members) {
        expect(Object.keys(member).sort()).toEqual(['displayName', 'email', 'joinedAt', 'role', 'status', 'userId']);
      }
      expect(members.find((m) => m.userId === userId.owner)?.role).toBe('owner');
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|password/i);
    });
  });
});
