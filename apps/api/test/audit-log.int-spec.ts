import type { AuditLogPage } from '@frontdesk/shared';
import { sql } from 'kysely';
import { encodeAuditCursor } from '../src/audit/audit-cursor.js';
import type { Db } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import { as, loginRequest, signIn, type TestApp, uniqueIp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

describe('audit log endpoint', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  let ownerToken: string;
  let adminToken: string;

  const at = (timestamp: string) => sql<Date>`${timestamp}::timestamptz`;

  async function insertEntries(practiceId: string | null, action: string, timestamps: string[]) {
    await owner
      .insertInto('audit_logs')
      .values(
        timestamps.map((timestamp) => ({
          practice_id: practiceId,
          actor_user_id: null,
          action,
          target_type: null,
          target_id: null,
          request_id: null,
          ip: null,
          occurred_at: at(timestamp),
        })),
      )
      .execute();
  }

  /** Follows nextCursor to the end and returns every entry in the order served. */
  async function readAll(token: string, limit: number, extra = '') {
    const items: AuditLogPage['items'] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `limit=${limit}${cursor ? `&cursor=${cursor}` : ''}${extra}`;
      const res = await as(app, token).get(`/api/audit-logs?${query}`).expect(200);
      const page = res.body as AuditLogPage;
      items.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(200); // never loop forever
    } while (cursor);
    return { items, pages };
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    await addMember(owner, alpha.practiceId, 'admin@alpha.test', 'admin');
    await addMember(owner, alpha.practiceId, 'staff@alpha.test', 'staff');
    await addMember(owner, alpha.practiceId, 'viewer@alpha.test', 'viewer');
    app = await startTestApp();
    ownerToken = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    adminToken = (await signIn(app, { email: 'admin@alpha.test' })).session.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  it('is limited to people allowed to read it', async () => {
    const staff = (await signIn(app, { email: 'staff@alpha.test' })).session.accessToken;
    const viewer = (await signIn(app, { email: 'viewer@alpha.test' })).session.accessToken;
    await as(app, staff).get('/api/audit-logs').expect(403);
    await as(app, viewer).get('/api/audit-logs').expect(403);
    await as(app, 'not-a-token').get('/api/audit-logs').expect(401);
    await as(app, adminToken).get('/api/audit-logs').expect(200);
  });

  it('describes each event: who, what, from where, and never more than identifiers', async () => {
    const ip = uniqueIp();
    await loginRequest(app, { email: 'viewer@alpha.test' }, ip).expect(200);

    const page = (await as(app, ownerToken).get('/api/audit-logs?limit=5').expect(200)).body as AuditLogPage;
    const login = page.items.find((entry) => entry.action === 'auth.login.success' && entry.ip === ip)!;

    expect(login).toBeDefined();
    expect(Object.keys(login).sort()).toEqual(['action', 'actorName', 'actorUserId', 'id', 'ip', 'metadata', 'occurredAt', 'requestId', 'targetId', 'targetType']);
    expect(login.actorName).toBe('Member viewer@alpha.test');
    expect(login.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(login.occurredAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(page)).not.toMatch(/argon2|password|refresh/i);
  });

  describe('pagination', () => {
    beforeAll(async () => {
      // 12 ordinary entries spread over time, 5 sharing one instant, and 3 a microsecond apart.
      await insertEntries(alpha.practiceId, 'test.spread', Array.from({ length: 12 }, (_, i) => `2026-01-01 00:00:${String(i).padStart(2, '0')}.5+00`));
      await insertEntries(alpha.practiceId, 'test.same-instant', Array.from({ length: 5 }, () => '2026-01-02 00:00:00.123456+00'));
      await insertEntries(alpha.practiceId, 'test.microseconds', ['2026-01-03 00:00:00.000001+00', '2026-01-03 00:00:00.000002+00', '2026-01-03 00:00:00.000003+00']);
    });

    it('serves newest first', async () => {
      const page = (await as(app, ownerToken).get('/api/audit-logs?limit=200').expect(200)).body as AuditLogPage;
      const times = page.items.map((entry) => new Date(entry.occurredAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it.each([1, 2, 3, 7, 50])('walks the whole log in pages of %i, exactly once each and in the same order as the database', async (limit) => {
      const expected = await owner
        .selectFrom('audit_logs')
        .select('id')
        .where('practice_id', '=', alpha.practiceId)
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .execute();

      const { items } = await readAll(ownerToken, limit);

      expect(items.map((entry) => entry.id)).toEqual(expected.map((row) => row.id));
      expect(new Set(items.map((entry) => entry.id)).size).toBe(items.length);
    });

    it('does not skip or repeat entries that share an instant, or differ by a single microsecond', async () => {
      const { items } = await readAll(ownerToken, 1);
      expect(items.filter((e) => e.action === 'test.same-instant')).toHaveLength(5);
      expect(items.filter((e) => e.action === 'test.microseconds')).toHaveLength(3);
      expect(items.filter((e) => e.action === 'test.spread')).toHaveLength(12);
    });

    it('returns a nextCursor only when there is more to read', async () => {
      const total = (await owner.selectFrom('audit_logs').select((eb) => eb.fn.countAll().as('n')).where('practice_id', '=', alpha.practiceId).executeTakeFirstOrThrow()).n;
      const all = (await as(app, ownerToken).get('/api/audit-logs?limit=200').expect(200)).body as AuditLogPage;
      expect(all.items).toHaveLength(Number(total));
      expect(all.nextCursor).toBeNull();

      const exact = (await as(app, ownerToken).get(`/api/audit-logs?limit=${Number(total)}`).expect(200)).body as AuditLogPage;
      expect(exact.nextCursor).toBeNull(); // a full page that ends the log must not promise another

      const partial = (await as(app, ownerToken).get(`/api/audit-logs?limit=${Number(total) - 1}`).expect(200)).body as AuditLogPage;
      expect(partial.nextCursor).not.toBeNull();
    });

    it('defaults to 50 entries a page', async () => {
      for (let batch = 0; batch < 4; batch++) {
        await insertEntries(alpha.practiceId, 'test.bulk', Array.from({ length: 20 }, () => '2025-12-01 00:00:00+00'));
      }
      const page = (await as(app, ownerToken).get('/api/audit-logs').expect(200)).body as AuditLogPage;
      expect(page.items).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
    });
  });

  describe('input validation', () => {
    it.each(['limit=0', 'limit=-1', 'limit=201', 'limit=abc', 'limit=1.5', 'limit=', 'cursor=', 'cursor=not-a-cursor', `cursor=${'A'.repeat(201)}`, 'sort=asc', 'practiceId=x'])(
      'rejects ?%s',
      async (query) => {
        await as(app, ownerToken).get(`/api/audit-logs?${query}`).expect(400);
      },
    );

    it('rejects a well-formed but forged cursor', async () => {
      const forged = encodeAuditCursor({ at: "2026-01-01 00:00:00+00'; drop table audit_logs; --", id: alpha.ownerId });
      await as(app, ownerToken).get(`/api/audit-logs?cursor=${forged}`).expect(400);
      expect(Number((await owner.selectFrom('audit_logs').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBeGreaterThan(0);
    });
  });

  describe('tenant isolation', () => {
    it('never shows another practice’s entries, or entries that belong to no practice', async () => {
      await insertEntries(beta.practiceId, 'test.beta-only', ['2026-02-01 00:00:00+00']);
      await insertEntries(null, 'test.no-practice', ['2026-02-01 00:00:00+00']);

      const alphaView = (await readAll(ownerToken, 50)).items.map((e) => e.action);
      expect(alphaView).not.toContain('test.beta-only');
      expect(alphaView).not.toContain('test.no-practice');
      expect(alphaView).toContain('test.spread');

      const betaToken = (await signIn(app, { email: beta.ownerEmail })).session.accessToken;
      const betaView = (await readAll(betaToken, 50)).items.map((e) => e.action);
      expect(betaView).toContain('test.beta-only');
      expect(betaView).not.toContain('test.spread');
    });

    it('does not let another practice’s cursor reveal anything', async () => {
      const betaRow = await owner.selectFrom('audit_logs').select(['id', sql<string>`occurred_at::text`.as('at')]).where('action', '=', 'test.beta-only').executeTakeFirstOrThrow();
      const cursor = encodeAuditCursor({ at: betaRow.at, id: betaRow.id });
      const res = await as(app, ownerToken).get(`/api/audit-logs?limit=200&cursor=${cursor}`).expect(200);
      const actions = (res.body as AuditLogPage).items.map((e) => e.action);
      expect(actions).not.toContain('test.beta-only');
    });
  });
});
