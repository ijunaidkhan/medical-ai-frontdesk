import { sql } from 'kysely';
import { NO_MIGRATIONS } from 'kysely/migration';
import { createMigrator } from '../src/database/migrator.js';
import type { Db } from '../src/database/database.module.js';
import { connect, seedPractice } from './support/fixtures.js';
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

  async function schedulingTableCount(): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables
      where schemaname = 'public' and tablename in ('scheduling_settings','providers','appointment_types','provider_appointment_types','provider_time_off','patients','appointments')`.execute(db);
    return Number(rows[0]?.n);
  }

  it('can be fully reverted and reapplied', async () => {
    const migrator = createMigrator(db);
    expect(await tableCount()).toBe(5);
    expect(await schedulingTableCount()).toBe(7);

    const down = await migrator.migrateTo(NO_MIGRATIONS); // revert everything
    expect(down.error).toBeUndefined();
    expect(await tableCount()).toBe(0);
    expect(await schedulingTableCount()).toBe(0);

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(await tableCount()).toBe(5);
    expect(await schedulingTableCount()).toBe(7);
  });

  it('0009 switches off a practice whose AI is already on without a crisis message, and records it', async () => {
    const migrator = createMigrator(db);
    const back = await migrator.migrateTo('0008_conversations'); // undo only the crisis-message migration
    expect(back.error).toBeUndefined();

    const on = await seedPractice(db, 'was-on');
    const off = await seedPractice(db, 'was-off');
    for (const [practice, enabled] of [[on, true], [off, false]] as const) {
      await sql`insert into ai_settings (practice_id, enabled, greeting, emergency_message)
        values (${practice.practiceId}, ${enabled}, 'Hello', 'Call 911 in a medical emergency.')`.execute(db);
    }

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const rows = await db.selectFrom('ai_settings').select(['practice_id', 'enabled', 'crisis_message']).execute();
    expect(rows.find((row) => row.practice_id === on.practiceId)).toMatchObject({ enabled: false, crisis_message: '' });
    expect(rows.find((row) => row.practice_id === off.practiceId)).toMatchObject({ enabled: false, crisis_message: '' });

    const events = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'ai.disabled').where('actor_type', '=', 'system').execute();
    expect(events).toHaveLength(1); // only the practice that was actually on
    expect(events[0]).toMatchObject({ practice_id: on.practiceId, actor_user_id: null, target_id: on.practiceId, metadata: { reason: 'crisis_message_required' } });

    // From now on the database itself refuses the AI without a crisis message.
    await expect(db.updateTable('ai_settings').set({ enabled: true }).where('practice_id', '=', on.practiceId).execute()).rejects.toThrow(/check constraint/);
  });

  it('is safe to run again when everything is already applied', async () => {
    const result = await createMigrator(db).migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results ?? []).toHaveLength(0);
  });
});
