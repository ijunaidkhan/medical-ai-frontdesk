import { sql } from 'kysely';
import { NO_MIGRATIONS } from 'kysely/migration';
import { createMigrator } from '../src/database/migrator.js';
import type { Db } from '../src/database/database.module.js';
import { connect } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

describe('migrations', () => {
  let database: IsolatedDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    db = connect(database.ownerUrl);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  async function tableCount(): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables
      where schemaname = 'public' and tablename in ('practices','users','memberships','refresh_tokens','audit_logs')`.execute(db);
    return Number(rows[0]?.n);
  }

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

  it('is safe to run again when everything is already applied', async () => {
    const result = await createMigrator(db).migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results ?? []).toHaveLength(0);
  });
});
