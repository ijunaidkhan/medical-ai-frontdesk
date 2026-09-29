import { ROLES } from '@frontdesk/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createDatabase, type Db } from '../src/database/database.module.js';
import type { Database } from '../src/database/database.types.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { connect } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

async function countRows(db: Kysely<Database>, table: keyof Database): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(db);
  return Number(rows[0]?.n);
}

describe('tenant isolation (row-level security)', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: Db;
  let practiceA: string;
  let practiceB: string;
  let userA: string; // member of A only
  let userB: string; // member of B only
  let userBoth: string; // member of both

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    owner = connect(database.ownerUrl);
    app = createDatabase(database.appUrl);

    const practices = await owner
      .insertInto('practices')
      .values([
        { name: 'Practice A', slug: 'practice-a', phone: null },
        { name: 'Practice B', slug: 'practice-b', phone: null },
      ])
      .returning(['id', 'slug'])
      .execute();
    practiceA = practices.find((p) => p.slug === 'practice-a')!.id;
    practiceB = practices.find((p) => p.slug === 'practice-b')!.id;

    const users = await owner
      .insertInto('users')
      .values(
        ['a', 'b', 'both'].map((name) => ({
          email: `${name}@example.test`,
          // Not a real credential: the isolation tests never authenticate.
          password_hash: 'not-a-real-hash',
          display_name: `User ${name}`,
          locked_until: null,
          last_login_at: null,
        })),
      )
      .returning(['id', 'email'])
      .execute();
    const idOf = (name: string) => users.find((u) => u.email === `${name}@example.test`)!.id;
    userA = idOf('a');
    userB = idOf('b');
    userBoth = idOf('both');

    await owner
      .insertInto('memberships')
      .values([
        { practice_id: practiceA, user_id: userA, role: 'owner' },
        { practice_id: practiceA, user_id: userBoth, role: 'staff' },
        { practice_id: practiceB, user_id: userB, role: 'owner' },
        { practice_id: practiceB, user_id: userBoth, role: 'viewer' },
      ])
      .execute();

    await owner
      .insertInto('refresh_tokens')
      .values(
        [practiceA, practiceB].map((practice_id, i) => ({
          user_id: i === 0 ? userA : userB,
          practice_id,
          family_id: crypto.randomUUID(),
          token_hash: Buffer.alloc(32, i + 1),
          expires_at: new Date(Date.now() + 3_600_000),
          session_expires_at: new Date(Date.now() + 3_600_000),
          revoked_at: null,
          replaced_by_id: null,
          created_ip: null,
          user_agent: null,
        })),
      )
      .execute();

    await owner
      .insertInto('audit_logs')
      .values([
        { practice_id: practiceA, actor_user_id: userA, action: 'seed.a', target_type: null, target_id: null, request_id: null, ip: null },
        { practice_id: practiceB, actor_user_id: userB, action: 'seed.b', target_type: null, target_id: null, request_id: null, ip: null },
      ])
      .execute();
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
    await database.drop();
  });

  describe('the runtime role', () => {
    it('is not a superuser and cannot bypass row-level security', async () => {
      const { rows } = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
        select rolsuper, rolbypassrls from pg_roles where rolname = current_user`.execute(app);
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('cannot change the schema or switch row-level security off', async () => {
      await expect(sql`create table sneaky (id int)`.execute(app)).rejects.toThrow(/permission denied/);
      await expect(sql`alter table memberships disable row level security`.execute(app)).rejects.toThrow(
        /must be owner/,
      );
    });
  });

  describe('without a practice context', () => {
    it.each(['practices', 'users', 'memberships', 'refresh_tokens', 'audit_logs'] as const)(
      'returns no rows from %s',
      async (table) => {
        expect(await countRows(app, table)).toBe(0);
      },
    );

    it('confirms the data really exists (seen by the owner)', async () => {
      expect(await countRows(owner, 'practices')).toBe(2);
      expect(await countRows(owner, 'memberships')).toBe(4);
    });
  });

  describe('inside practice A', () => {
    it('sees only its own practice, memberships, sessions and audit entries', async () => {
      await withPracticeContext(app, { practiceId: practiceA }, async (trx) => {
        expect((await trx.selectFrom('practices').select('id').execute()).map((r) => r.id)).toEqual([practiceA]);

        const memberships = await trx.selectFrom('memberships').select('practice_id').execute();
        expect(memberships).toHaveLength(2);
        expect(memberships.every((m) => m.practice_id === practiceA)).toBe(true);

        const tokens = await trx.selectFrom('refresh_tokens').select('practice_id').execute();
        expect(tokens.map((t) => t.practice_id)).toEqual([practiceA]);

        const audit = await trx.selectFrom('audit_logs').select('action').execute();
        expect(audit.map((a) => a.action)).toEqual(['seed.a']);
      });
    });

    it('cannot fetch another practice by its exact id', async () => {
      await withPracticeContext(app, { practiceId: practiceA }, async (trx) => {
        const other = await trx.selectFrom('practices').selectAll().where('id', '=', practiceB).executeTakeFirst();
        expect(other).toBeUndefined();
      });
    });

    it('sees only the users who belong to practice A', async () => {
      await withPracticeContext(app, { practiceId: practiceA }, async (trx) => {
        const emails = (await trx.selectFrom('users').select('email').execute()).map((u) => u.email).sort();
        expect(emails).toEqual(['a@example.test', 'both@example.test']);
      });
    });

    it('can additionally see the acting user themself', async () => {
      await withPracticeContext(app, { practiceId: practiceA, userId: userB }, async (trx) => {
        const emails = (await trx.selectFrom('users').select('email').execute()).map((u) => u.email).sort();
        expect(emails).toEqual(['a@example.test', 'b@example.test', 'both@example.test']);
      });
    });

    it("cannot write a session into another practice (row-level security's write check)", async () => {
      await expect(
        withPracticeContext(app, { practiceId: practiceA }, (trx) =>
          trx
            .insertInto('refresh_tokens')
            .values({
              user_id: userA,
              practice_id: practiceB,
              family_id: crypto.randomUUID(),
              token_hash: Buffer.alloc(32, 9),
              expires_at: new Date(Date.now() + 3_600_000),
              session_expires_at: new Date(Date.now() + 3_600_000),
              revoked_at: null,
              replaced_by_id: null,
              created_ip: null,
              user_agent: null,
            })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('has no privilege to create memberships, in any practice', async () => {
      for (const practice_id of [practiceA, practiceB]) {
        await expect(
          withPracticeContext(app, { practiceId: practiceA }, (trx) =>
            trx.insertInto('memberships').values({ practice_id, user_id: userA, role: 'admin' }).execute(),
          ),
        ).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot modify another practice's sessions (the update matches nothing)", async () => {
      const result = await withPracticeContext(app, { practiceId: practiceA }, (trx) =>
        trx
          .updateTable('refresh_tokens')
          .set({ revoked_at: new Date() })
          .where('practice_id', '=', practiceB)
          .executeTakeFirst(),
      );
      expect(result.numUpdatedRows).toBe(0n);
      expect(await owner.selectFrom('refresh_tokens').select('revoked_at').where('practice_id', '=', practiceB).execute()).toEqual([
        { revoked_at: null },
      ]);
    });

    it('has no privilege to write practices or users at all', async () => {
      await expect(
        withPracticeContext(app, { practiceId: practiceA }, (trx) =>
          trx.updateTable('practices').set({ name: 'hijacked' }).execute(),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withPracticeContext(app, { practiceId: practiceA }, (trx) =>
          trx.updateTable('users').set({ display_name: 'hijacked' }).execute(),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('context handling', () => {
    it('does not leak to the next transaction on the same pooled connection', async () => {
      const singleConnection = new Kysely<Database>({
        dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: database.appUrl, max: 1 }) }),
      });
      try {
        const inside = await withPracticeContext(singleConnection, { practiceId: practiceA }, (trx) =>
          countRows(trx, 'practices'),
        );
        expect(inside).toBe(1);
        expect(await countRows(singleConnection, 'practices')).toBe(0);
      } finally {
        await singleConnection.destroy();
      }
    });

    it.each(['not-a-uuid', "'; drop table practices; --", ''])('rejects a malformed practice id: %j', async (bad) => {
      await expect(withPracticeContext(app, { practiceId: bad }, async () => 'unreachable')).rejects.toThrow(/UUID/);
    });
  });

  describe('audit log', () => {
    it('accepts entries for the current practice and for no practice', async () => {
      await withPracticeContext(app, { practiceId: practiceA }, (trx) =>
        trx
          .insertInto('audit_logs')
          .values({ practice_id: practiceA, actor_user_id: null, action: 'test.in-practice', target_type: null, target_id: null, request_id: null, ip: null })
          .execute(),
      );
      await app
        .insertInto('audit_logs')
        .values({ practice_id: null, actor_user_id: null, action: 'test.no-practice', target_type: null, target_id: null, request_id: null, ip: '203.0.113.7' })
        .execute();
    });

    it('rejects an entry written into another practice', async () => {
      await expect(
        withPracticeContext(app, { practiceId: practiceA }, (trx) =>
          trx
            .insertInto('audit_logs')
            .values({ practice_id: practiceB, actor_user_id: null, action: 'test.forged', target_type: null, target_id: null, request_id: null, ip: null })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('never shows practice-less entries to tenant users', async () => {
      await withPracticeContext(app, { practiceId: practiceA }, async (trx) => {
        const actions = (await trx.selectFrom('audit_logs').select('action').execute()).map((a) => a.action);
        expect(actions).not.toContain('test.no-practice');
      });
    });

    it('cannot be updated or deleted by the runtime role', async () => {
      await expect(
        withPracticeContext(app, { practiceId: practiceA }, (trx) => trx.updateTable('audit_logs').set({ action: 'x' }).execute()),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withPracticeContext(app, { practiceId: practiceA }, (trx) => trx.deleteFrom('audit_logs').execute()),
      ).rejects.toThrow(/permission denied/);
    });

    it('cannot be altered even by the schema owner without dropping the trigger', async () => {
      await expect(owner.updateTable('audit_logs').set({ action: 'tampered' }).execute()).rejects.toThrow(/append-only/);
      await expect(owner.deleteFrom('audit_logs').execute()).rejects.toThrow(/append-only/);
      await expect(sql`truncate audit_logs`.execute(owner)).rejects.toThrow(/append-only/);
    });
  });

  describe('data constraints', () => {
    it('accepts exactly the roles defined in @frontdesk/shared', async () => {
      const { rows } = await sql<{ def: string }>`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'memberships'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%role%'`.execute(owner);
      const allowed = [...(rows[0]?.def.matchAll(/'([a-z]+)'::text/g) ?? [])].map((m) => m[1]).sort();
      expect(allowed).toEqual([...ROLES].sort());
    });

    it('rejects an unknown role, a duplicate membership and a duplicate email', async () => {
      await expect(
        owner.insertInto('memberships').values({ practice_id: practiceB, user_id: userA, role: 'superadmin' as never }).execute(),
      ).rejects.toThrow(/check constraint/);
      await expect(
        owner.insertInto('memberships').values({ practice_id: practiceA, user_id: userA, role: 'viewer' }).execute(),
      ).rejects.toThrow(/duplicate key/);
      await expect(
        owner
          .insertInto('users')
          .values({ email: 'A@EXAMPLE.TEST', password_hash: 'x', display_name: 'dup', locked_until: null, last_login_at: null })
          .execute(),
      ).rejects.toThrow(/duplicate key/);
    });
  });
});
