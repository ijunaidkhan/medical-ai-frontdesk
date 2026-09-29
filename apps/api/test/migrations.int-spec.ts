import { Kysely, PostgresDialect, sql } from 'kysely';
import { NO_MIGRATIONS } from 'kysely/migration';
import pg from 'pg';
import { createMigrator } from '../src/database/migrator.js';

// Uses the owner connection to the (already migrated) test database.
describe('migrations', () => {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: process.env['MIGRATION_DATABASE_URL'], max: 2 }),
    }),
  });

  async function tableCount(): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables
      where schemaname = 'public' and tablename in ('practices','users','memberships','refresh_tokens','audit_logs')`.execute(db);
    return Number(rows[0]?.n);
  }

  afterAll(async () => {
    await db.destroy();
  });

  it('can be fully reverted and reapplied', async () => {
    const migrator = createMigrator(db);
    expect(await tableCount()).toBe(5);

    const down = await migrator.migrateTo(NO_MIGRATIONS); // revert everything
    expect(down.error).toBeUndefined();
    expect(await tableCount()).toBe(0);

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(await tableCount()).toBe(5);
  });
});
