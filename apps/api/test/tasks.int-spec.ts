import type { Role, Task, TaskPage } from '@frontdesk/shared';
import { sql } from 'kysely';
import type { AuthContext } from '../src/auth/auth-context.js';
import { createDatabase, type Db } from '../src/database/database.module.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { TenantDb } from '../src/tenancy/tenant-db.js';
import { startTestApp } from './support/app.js';
import { as, signIn, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const SOME_UUID = '0190ffff-0000-7000-8000-000000000000';

describe('staff tasks', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  const token: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  const userId: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  let staff2Id: string;
  let suspendedId: string;
  let betaUserId: string;
  let betaToken: string;

  const create = async (body: object, t = token.staff) => (await as(app, t).post('/api/tasks', body).expect(201)).body as Task;
  const patch = (id: string, body: object, t = token.staff) => as(app, t).patch(`/api/tasks/${id}`, body);
  const list = async (query = '', t = token.staff) => (await as(app, t).get(`/api/tasks${query}`).expect(200)).body as TaskPage;
  const audit = (action: string, targetId: string) =>
    owner.selectFrom('audit_logs').selectAll().where('action', '=', action).where('target_id', '=', targetId).orderBy('occurred_at').execute();
  const row = (id: string) => owner.selectFrom('staff_tasks').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

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
    staff2Id = await addMember(owner, alpha.practiceId, 'staff2@alpha.test', 'staff');
    suspendedId = await addMember(owner, alpha.practiceId, 'suspended@alpha.test', 'staff');
    await owner.updateTable('memberships').set({ status: 'suspended' }).where('user_id', '=', suspendedId).execute();
    betaUserId = beta.ownerId;
    app = await startTestApp();
    token.owner = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    token.admin = (await signIn(app, { email: 'admin@alpha.test' })).session.accessToken;
    token.staff = (await signIn(app, { email: 'staff@alpha.test' })).session.accessToken;
    token.viewer = (await signIn(app, { email: 'viewer@alpha.test' })).session.accessToken;
    betaToken = (await signIn(app, { email: beta.ownerEmail })).session.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  describe('who may do what', () => {
    let taskId: string;
    beforeAll(async () => {
      taskId = (await create({ type: 'callback', title: 'Permissions probe' })).id;
    });

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])('reading as %s -> %i', async (role, status) => {
      await as(app, token[role]).get('/api/tasks').expect(status);
      await as(app, token[role]).get(`/api/tasks/${taskId}`).expect(status);
    });

    it.each<[Role, number]>([['owner', 201], ['admin', 201], ['staff', 201], ['viewer', 403]])('creating as %s -> %i (staff work the queue)', async (role, status) => {
      await as(app, token[role]).post('/api/tasks', { type: 'message', title: 'x' }).expect(status);
    });

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])('updating as %s -> %i', async (role, status) => {
      // A different title each time, so every request is a real change (an unchanged one is refused as "nothing to change").
      await patch(taskId, { title: `Permissions probe by ${role}` }, token[role]).expect(status);
    });

    it('everything needs a login', async () => {
      await as(app, 'no-token').get('/api/tasks').expect(401);
      await as(app, 'no-token').post('/api/tasks', {}).expect(401);
      await as(app, 'no-token').patch(`/api/tasks/${taskId}`, {}).expect(401);
    });
  });

  describe('creating', () => {
    it('needs only a type and a title, and starts open, normal priority, unassigned, made by the person', async () => {
      const task = await create({ type: 'callback', title: '  Call Ms Ahmed back  ' });
      expect(task).toMatchObject({
        type: 'callback',
        status: 'open',
        priority: 'normal',
        title: 'Call Ms Ahmed back',
        details: null,
        contactName: null,
        contactPhone: null,
        assignedTo: null,
        dueAt: null,
        completedAt: null,
        createdBy: { kind: 'user', person: { userId: userId.staff, name: 'Member staff@alpha.test' } },
      });
    });

    it('stores every field, and assigns to an active member', async () => {
      const due = '2026-10-05T09:30:00.000Z';
      const task = await create({
        type: 'message',
        title: 'Message about test results',
        details: '  Wants to know when they will be ready.  ',
        contactName: 'Sara Khan',
        contactPhone: '+923001234567',
        priority: 'urgent',
        dueAt: due,
        assignedTo: staff2Id,
      });
      expect(task).toMatchObject({
        details: 'Wants to know when they will be ready.',
        contactName: 'Sara Khan',
        contactPhone: '+923001234567',
        priority: 'urgent',
        dueAt: due,
        assignedTo: { userId: staff2Id, name: 'Member staff2@alpha.test' },
      });
    });

    it('stores empty details as nothing, not as an empty string', async () => {
      const task = await create({ type: 'other', title: 'Blank details', details: '   ' });
      expect(task.details).toBeNull();
      expect((await row(task.id)).details).toBeNull();
    });

    it('records who created it, without any of its content', async () => {
      const task = await create({ type: 'callback', title: 'Secret patient title', details: 'Secret detail', contactName: 'Secret Name', contactPhone: '+14155550199' });
      const entries = await audit('task.created', task.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ practice_id: alpha.practiceId, actor_user_id: userId.staff, target_type: 'task' });
      expect(entries[0]!.metadata).toEqual({ type: 'callback', priority: 'normal', source: 'user' });
      expect(JSON.stringify(entries)).not.toMatch(/Secret|4155550199/);
    });

    it.each([
      ['no type', { title: 't' }],
      ['an unknown type', { type: 'sms', title: 't' }],
      ['no title', { type: 'callback' }],
      ['a blank title', { type: 'callback', title: '  ' }],
      ['a title over 200 characters', { type: 'callback', title: 't'.repeat(201) }],
      ['details over 4000 characters', { type: 'callback', title: 't', details: 'd'.repeat(4001) }],
      ['a contact name over 120 characters', { type: 'callback', title: 't', contactName: 'n'.repeat(121) }],
      ['a blank contact name', { type: 'callback', title: 't', contactName: '  ' }],
      ['a phone without a country code', { type: 'callback', title: 't', contactPhone: '415-555-0123' }],
      ['a phone that is too short', { type: 'callback', title: 't', contactPhone: '+123' }],
      ['a phone with letters', { type: 'callback', title: 't', contactPhone: '+1415abc0123' }],
      ['an unknown priority', { type: 'callback', title: 't', priority: 'critical' }],
      ['a due date that is not a date', { type: 'callback', title: 't', dueAt: 'tomorrow' }],
      ['an impossible due date', { type: 'callback', title: 't', dueAt: '2026-13-45T00:00:00Z' }],
      ['an assignee that is not an id', { type: 'callback', title: 't', assignedTo: 'sara' }],
      ['an attempt to set the status', { type: 'callback', title: 't', status: 'done' }],
      ['an attempt to say the AI made it', { type: 'callback', title: 't', createdByType: 'ai' }],
      ['an attempt to name the creator', { type: 'callback', title: 't', createdBy: SOME_UUID }],
      ['an attempt to choose the practice', { type: 'callback', title: 't', practiceId: SOME_UUID }],
      ['an attempt to mark it completed', { type: 'callback', title: 't', completedAt: '2026-01-01T00:00:00Z' }],
    ])('rejects %s', async (_label, body) => {
      await as(app, token.staff).post('/api/tasks', body).expect(400);
    });

    it.each([
      ['someone who is not in this practice at all', () => SOME_UUID],
      ['a member of ANOTHER practice', () => betaUserId],
      ['a suspended member', () => suspendedId],
    ])('cannot be assigned to %s', async (_label, who) => {
      const res = await as(app, token.staff).post('/api/tasks', { type: 'callback', title: 't', assignedTo: who() }).expect(400);
      expect(res.body.message).toBe('That person is not an active member of this practice');
    });
  });

  describe('listing', () => {
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      // A small, known set in its own practice-wide space: everything created below carries a marker title.
      ids['open1'] = (await create({ type: 'callback', title: 'L open one' })).id;
      ids['open2'] = (await create({ type: 'message', title: 'L open two', assignedTo: userId.staff })).id;
      ids['progress'] = (await create({ type: 'callback', title: 'L in progress', assignedTo: staff2Id })).id;
      await patch(ids['progress']!, { status: 'in_progress' }).expect(200);
      ids['done'] = (await create({ type: 'question', title: 'L done' })).id;
      await patch(ids['done']!, { status: 'done' }).expect(200);
      ids['cancelled'] = (await create({ type: 'other', title: 'L cancelled' })).id;
      await patch(ids['cancelled']!, { status: 'cancelled' }).expect(200);
    });

    const titles = (page: TaskPage) => page.items.map((t) => t.title).filter((t) => t.startsWith('L '));

    it('shows the work queue (open and in progress) by default, newest first', async () => {
      expect(titles(await list('?limit=200'))).toEqual(['L in progress', 'L open two', 'L open one']);
    });

    it.each([
      ['status=open', ['L open two', 'L open one']],
      ['status=in_progress', ['L in progress']],
      ['status=done', ['L done']],
      ['status=cancelled', ['L cancelled']],
      ['status=all', ['L cancelled', 'L done', 'L in progress', 'L open two', 'L open one']],
      ['status=active', ['L in progress', 'L open two', 'L open one']],
    ])('filters by %s', async (query, expected) => {
      expect(titles(await list(`?${query}&limit=200`))).toEqual(expected);
    });

    it('filters by who it is assigned to: me, unassigned, or a person', async () => {
      expect(titles(await list('?assignee=me&limit=200', token.staff))).toEqual(['L open two']);
      expect(titles(await list('?assignee=unassigned&limit=200'))).toEqual(['L open one']);
      expect(titles(await list(`?assignee=${staff2Id}&limit=200`))).toEqual(['L in progress']);
      expect(titles(await list('?assignee=me&limit=200', token.owner))).toEqual([]); // "me" is the caller, not a fixed person
    });

    it.each(['status=bogus', 'assignee=sara', 'limit=0', 'limit=201', 'limit=abc', 'cursor=junk', 'practiceId=x', 'sort=asc'])('rejects ?%s', async (query) => {
      await as(app, token.staff).get(`/api/tasks?${query}`).expect(400);
    });

    it.each([1, 2, 3, 100])('walks the whole queue in pages of %i: every task once, in the same order as the database', async (limit) => {
      const expected = await owner
        .selectFrom('staff_tasks')
        .select('id')
        .where('practice_id', '=', alpha.practiceId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: TaskPage = await list(`?status=all&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...page.items.map((t) => t.id));
        cursor = page.nextCursor;
        expect(++pages).toBeLessThan(500);
      } while (cursor);

      expect(seen).toEqual(expected.map((r) => r.id));
    });

    it('does not skip or repeat tasks that were created at the same instant', async () => {
      await owner
        .insertInto('staff_tasks')
        .values(
          Array.from({ length: 6 }, (_, i) => ({
            practice_id: alpha.practiceId,
            type: 'other' as const,
            title: `same instant ${i}`,
            details: null,
            contact_name: null,
            contact_phone: null,
            created_by_type: 'ai' as const,
            created_by: null,
            assigned_to: null,
            due_at: null,
            completed_at: null,
            completed_by: null,
            created_at: sql<Date>`'2026-02-01 00:00:00.000001+00'::timestamptz`,
          })),
        )
        .execute();
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: TaskPage = await list(`?status=all&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...page.items.filter((t) => t.title.startsWith('same instant')).map((t) => t.title));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen.sort()).toEqual(['same instant 0', 'same instant 1', 'same instant 2', 'same instant 3', 'same instant 4', 'same instant 5']);
    });
  });

  describe('updating', () => {
    it('changes only what is sent, and null clears an optional field', async () => {
      const task = await create({ type: 'callback', title: 'Editable', details: 'first', contactName: 'Sara', contactPhone: '+14155550123', dueAt: '2026-10-05T09:00:00Z', priority: 'normal' });
      const changed = (await patch(task.id, { title: '  Renamed  ', priority: 'urgent' }).expect(200)).body as Task;
      expect(changed).toMatchObject({ title: 'Renamed', priority: 'urgent', details: 'first', contactName: 'Sara', contactPhone: '+14155550123' });

      const cleared = (await patch(task.id, { details: null, contactName: null, contactPhone: null, dueAt: null }).expect(200)).body as Task;
      expect(cleared).toMatchObject({ details: null, contactName: null, contactPhone: null, dueAt: null, title: 'Renamed' });
    });

    it('records what changed as field names only', async () => {
      const task = await create({ type: 'callback', title: 'Audit fields', details: 'x' });
      await patch(task.id, { title: 'Audit fields 2', details: 'secret new detail', priority: 'urgent' }).expect(200);
      const entry = (await audit('task.updated', task.id)).at(-1)!;
      expect(entry.metadata).toEqual({ fields: ['title', 'details', 'priority'] });
      expect(JSON.stringify(entry)).not.toContain('secret new detail');
    });

    it('assigns, reassigns and unassigns, recording each', async () => {
      const task = await create({ type: 'callback', title: 'Assignable' });
      await patch(task.id, { assignedTo: userId.staff }).expect(200);
      await patch(task.id, { assignedTo: staff2Id }).expect(200);
      const cleared = (await patch(task.id, { assignedTo: null }).expect(200)).body as Task;
      expect(cleared.assignedTo).toBeNull();

      const entries = await audit('task.assigned', task.id);
      expect(entries.map((e) => e.metadata)).toEqual([
        { from: null, to: userId.staff },
        { from: userId.staff, to: staff2Id },
        { from: staff2Id, to: null },
      ]);
    });

    it.each([
      ['someone in another practice', () => betaUserId],
      ['a suspended member', () => suspendedId],
      ['a person who does not exist', () => SOME_UUID],
    ])('cannot be assigned to %s', async (_label, who) => {
      const task = await create({ type: 'callback', title: 'Assign refusal' });
      await patch(task.id, { assignedTo: who() }).expect(400);
      expect((await row(task.id)).assigned_to).toBeNull();
    });

    it.each([
      ['nothing', {}],
      ['values it already has', { priority: 'normal', status: 'open' }],
      ['a blank title', { title: '  ' }],
      ['a null title', { title: null }],
      ['a null priority', { priority: null }],
      ['an unknown status', { status: 'finished' }],
      ['a bad phone', { contactPhone: '12345' }],
      ['its type (fixed once created)', { type: 'message' }],
      ['who created it', { createdBy: SOME_UUID }],
      ['the practice', { practiceId: SOME_UUID }],
      ['the completion time', { completedAt: '2026-01-01T00:00:00Z' }],
    ])('rejects an update with %s', async (_label, body) => {
      const task = await create({ type: 'callback', title: 'Strict update' });
      await patch(task.id, body).expect(400);
    });
  });

  describe('status', () => {
    it('moves through open, in progress and done, records who completed it, and audits each move', async () => {
      const task = await create({ type: 'callback', title: 'Lifecycle' });
      await patch(task.id, { status: 'in_progress' }, token.staff).expect(200);
      const done = (await patch(task.id, { status: 'done' }, token.admin).expect(200)).body as Task;

      expect(done.status).toBe('done');
      expect(done.completedAt).not.toBeNull();
      const stored = await row(task.id);
      expect(stored.completed_by).toBe(userId.admin);
      expect((await audit('task.status_changed', task.id)).map((e) => e.metadata)).toEqual([
        { from: 'open', to: 'in_progress' },
        { from: 'in_progress', to: 'done' },
      ]);
    });

    it('can be reopened, which clears the completion; cancelling and reopening works too', async () => {
      const task = await create({ type: 'callback', title: 'Reopen me' });
      await patch(task.id, { status: 'done' }).expect(200);
      const reopened = (await patch(task.id, { status: 'open' }).expect(200)).body as Task;
      expect(reopened).toMatchObject({ status: 'open', completedAt: null });
      expect(await row(task.id)).toMatchObject({ completed_at: null, completed_by: null });

      await patch(task.id, { status: 'cancelled' }).expect(200);
      expect(((await patch(task.id, { status: 'open' }).expect(200)).body as Task).status).toBe('open');
    });

    it.each([
      ['done', 'in_progress'],
      ['done', 'cancelled'],
      ['cancelled', 'done'],
      ['cancelled', 'in_progress'],
    ])('refuses %s -> %s: a finished task can only be reopened', async (from, to) => {
      const task = await create({ type: 'callback', title: `No ${from} to ${to}` });
      await patch(task.id, { status: from }).expect(200);
      const res = await patch(task.id, { status: to }).expect(409);
      expect(res.body.message).toContain('reopened');
      expect((await row(task.id)).status).toBe(from);
    });

    it.each(['done', 'cancelled'])('cannot be edited while %s: reopen it first', async (status) => {
      const task = await create({ type: 'callback', title: `Locked ${status}` });
      await patch(task.id, { status }).expect(200);
      for (const body of [{ title: 'changed' }, { priority: 'urgent' }, { assignedTo: userId.staff }, { status: 'open', title: 'changed while reopening' }]) {
        const res = await patch(task.id, body).expect(409);
        expect(res.body.message).toBe('Reopen the task before editing it');
      }
      expect((await row(task.id)).title).toBe(`Locked ${status}`);
    });

    it('turns two people finishing the same task in different ways into one success and one refusal', async () => {
      const task = await create({ type: 'callback', title: 'Race' });
      const results = await Promise.all([patch(task.id, { status: 'done' }, token.staff), patch(task.id, { status: 'cancelled' }, token.admin)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(['done', 'cancelled']).toContain((await row(task.id)).status);
    });
  });

  describe('tasks made by the AI receptionist (a later step uses this path)', () => {
    it('are stored as AI-made, with no creator, and audited as such', async () => {
      const service = app.get(TasksService);
      const tenant = app.get(TenantDb);
      const auth: AuthContext = { userId: userId.owner, practiceId: alpha.practiceId, role: 'owner', sessionId: SOME_UUID };

      const id = await tenant.run(auth, (trx) =>
        service.createInTransaction(
          trx,
          alpha.practiceId,
          { type: 'callback', title: 'Caller asked to be phoned back', contactPhone: '+14155550111', priority: 'urgent' },
          { kind: 'ai' },
          { ip: null, userAgent: null, requestId: null },
        ),
      );

      const task = (await as(app, token.staff).get(`/api/tasks/${id}`).expect(200)).body as Task;
      expect(task.createdBy).toEqual({ kind: 'ai' });
      expect(task.priority).toBe('urgent');
      expect(await row(id)).toMatchObject({ created_by_type: 'ai', created_by: null });
      const entry = (await audit('task.created', id))[0]!;
      expect(entry.actor_user_id).toBeNull();
      expect(entry.metadata).toMatchObject({ source: 'ai' });
    });
  });

  describe('tenant isolation', () => {
    let betaTask: Task;
    beforeAll(async () => {
      betaTask = (await as(app, betaToken).post('/api/tasks', { type: 'callback', title: 'Beta private', contactName: 'Beta Patient', contactPhone: '+14155550999' }).expect(201)).body as Task;
    });

    it('never lists another practice’s tasks', async () => {
      const page = await list('?status=all&limit=200', token.owner);
      expect(page.items.some((t) => t.id === betaTask.id)).toBe(false);
      expect(JSON.stringify(page)).not.toMatch(/Beta private|Beta Patient|4155550999/);
      expect((await list('?status=all&limit=200', betaToken)).items.map((t) => t.title)).toEqual(['Beta private']);
    });

    it('cannot read or change another practice’s task: it does not exist for them', async () => {
      await as(app, token.owner).get(`/api/tasks/${betaTask.id}`).expect(404);
      await patch(betaTask.id, { status: 'done' }, token.owner).expect(404);
      await patch(betaTask.id, { title: 'hijacked' }, token.owner).expect(404);
      expect(await row(betaTask.id)).toMatchObject({ title: 'Beta private', status: 'open' });
    });

    describe('in the database itself (as the API’s restricted role)', () => {
      let appDb: Db;
      beforeAll(() => {
        appDb = createDatabase(database.appUrl);
      });
      afterAll(async () => {
        await appDb.destroy();
      });

      it('shows nothing without a practice context, and only the current practice’s tasks inside one', async () => {
        const { rows } = await sql<{ n: string }>`select count(*)::text as n from staff_tasks`.execute(appDb);
        expect(Number(rows[0]?.n)).toBe(0);
        const seen = await withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) => trx.selectFrom('staff_tasks').select('practice_id').execute());
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((r) => r.practice_id === alpha.practiceId)).toBe(true);
      });

      it('cannot delete tasks, or move one, or rewrite who created it or what type it is', async () => {
        const inAlpha = <T>(work: (trx: Parameters<Parameters<typeof withPracticeContext>[2]>[0]) => Promise<T>) =>
          withPracticeContext(appDb, { practiceId: alpha.practiceId }, work);
        await expect(inAlpha((trx) => trx.deleteFrom('staff_tasks').execute())).rejects.toThrow(/permission denied/);
        await expect(inAlpha((trx) => trx.updateTable('staff_tasks').set({ practice_id: beta.practiceId }).execute())).rejects.toThrow(/permission denied/);
        await expect(inAlpha((trx) => trx.updateTable('staff_tasks').set({ created_by: null }).execute())).rejects.toThrow(/permission denied/);
        await expect(inAlpha((trx) => trx.updateTable('staff_tasks').set({ type: 'other' }).execute())).rejects.toThrow(/permission denied/);
      });

      it('cannot create a task for another practice', async () => {
        await expect(
          withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) =>
            trx
              .insertInto('staff_tasks')
              .values({ practice_id: beta.practiceId, type: 'other', title: 't', details: null, contact_name: null, contact_phone: null, created_by_type: 'ai', created_by: null, assigned_to: null, due_at: null, completed_at: null, completed_by: null })
              .execute(),
          ),
        ).rejects.toThrow(/row-level security/);
      });

      it('cannot assign a task to a member of a different practice (foreign key)', async () => {
        const task = await create({ type: 'callback', title: 'FK probe' });
        await expect(owner.updateTable('staff_tasks').set({ assigned_to: betaUserId }).where('id', '=', task.id).execute()).rejects.toThrow(/foreign key/);
      });

      it('enforces its own rules: completion only when done, creator only for staff-made tasks', async () => {
        const task = await create({ type: 'callback', title: 'Constraint probe' });
        await expect(owner.updateTable('staff_tasks').set({ status: 'done' }).where('id', '=', task.id).execute()).rejects.toThrow(/check constraint/);
        await expect(owner.updateTable('staff_tasks').set({ completed_at: sql<Date>`now()` }).where('id', '=', task.id).execute()).rejects.toThrow(/check constraint/);
        await expect(owner.updateTable('staff_tasks').set({ contact_phone: '415-555-0123' }).where('id', '=', task.id).execute()).rejects.toThrow(/check constraint/);
        await expect(
          owner.insertInto('staff_tasks').values({ practice_id: alpha.practiceId, type: 'other', title: 't', details: null, contact_name: null, contact_phone: null, created_by_type: 'ai', created_by: userId.owner, assigned_to: null, due_at: null, completed_at: null, completed_by: null }).execute(),
        ).rejects.toThrow(/check constraint/);
        await expect(
          owner.insertInto('staff_tasks').values({ practice_id: alpha.practiceId, type: 'other', title: 't', details: null, contact_name: null, contact_phone: null, created_by_type: 'user', created_by: null, assigned_to: null, due_at: null, completed_at: null, completed_by: null }).execute(),
        ).rejects.toThrow(/check constraint/);
      });
    });
  });
});
