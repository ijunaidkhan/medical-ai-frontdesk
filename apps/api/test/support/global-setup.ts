import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createMigrator } from '../../src/database/migrator.js';
import { createTemplateDatabase, dropStaleTestDatabases } from './test-database.js';

/**
 * Builds the migrated template database once per run. Each test file then
 * copies it (a fast, file-level copy) so files never share or disturb data.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await dropStaleTestDatabases();
  const templateUrl = await createTemplateDatabase();

  const owner = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: templateUrl, max: 1 }) }),
  });
  try {
    const { error } = await createMigrator(owner).migrateToLatest();
    if (error) {
      throw error;
    }
  } finally {
    await owner.destroy(); // a template must have no open connections when it is copied
  }

  return dropStaleTestDatabases;
}
