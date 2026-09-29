/**
 * Migration command line. Uses the schema OWNER connection
 * (MIGRATION_DATABASE_URL), never the API's runtime role.
 *
 *   npm run db:migrate            apply all pending migrations
 *   npm run db:migrate:down       revert the most recent migration
 *   npm run db:migrate:status     list applied and pending migrations
 */
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createMigrator } from './migrator.js';

function loadLocalEnv(): void {
  // Real environment variables win; loadEnvFile never overrides them.
  for (const path of ['.env', resolve(process.cwd(), '../../.env')]) {
    try {
      process.loadEnvFile(path);
    } catch {
      // File absent: fine, the variables may come from the real environment.
    }
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const command = process.argv[2] ?? 'up';
  const connectionString = process.env['MIGRATION_DATABASE_URL'];
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL is not set (see .env.example).');
  }

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });

  try {
    const migrator = createMigrator(db);

    if (command === 'status') {
      for (const migration of await migrator.getMigrations()) {
        console.log(`${migration.executedAt ? 'applied' : 'pending'}  ${migration.name}`);
      }
      return;
    }

    const { error, results } =
      command === 'up' ? await migrator.migrateToLatest()
      : command === 'down' ? await migrator.migrateDown()
      : (() => {
          throw new Error(`Unknown command "${command}". Use: up | down | status`);
        })();

    for (const result of results ?? []) {
      console.log(`${result.status.toLowerCase()}  ${result.direction.toLowerCase()}  ${result.migrationName}`);
    }
    if (results?.length === 0) {
      console.log('nothing to do');
    }
    if (error) {
      throw error;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
