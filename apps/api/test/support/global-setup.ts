import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createMigrator } from '../../src/database/migrator.js';
import { TEST_DATABASE, testDatabaseUrls } from './test-database.js';

/** Recreates an empty test database and applies every migration as the schema owner. */
export default async function setup(): Promise<void> {
  const urls = testDatabaseUrls();

  const maintenance = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: urls.maintenance, max: 1 }) }),
  });
  try {
    await sql.raw(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`).execute(maintenance);
    await sql.raw(`CREATE DATABASE ${TEST_DATABASE}`).execute(maintenance);
  } finally {
    await maintenance.destroy();
  }

  const owner = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: urls.owner, max: 1 }) }),
  });
  try {
    const { error } = await createMigrator(owner).migrateToLatest();
    if (error) {
      throw error;
    }
  } finally {
    await owner.destroy();
  }
}
