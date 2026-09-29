import { resolve } from 'node:path';

export const TEST_DATABASE = 'frontdesk_test';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function loadLocalEnv(): void {
  // Real environment variables win; loadEnvFile never overrides them.
  for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    try {
      process.loadEnvFile(path);
    } catch {
      // File absent: the variables may come from the real environment.
    }
  }
}

function requireUrl(name: string): URL {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Integration tests need the local database: run "npm run db:up" and copy .env.example to .env.`,
    );
  }
  return new URL(value);
}

export interface TestDatabaseUrls {
  /** Owner connection to the maintenance database, used to (re)create the test database. */
  maintenance: string;
  /** Owner connection to the test database, used for migrations and seeding. */
  owner: string;
  /** Runtime-role connection to the test database, the one whose isolation is under test. */
  app: string;
}

/**
 * Resolves connection URLs for the dedicated test database. Refuses non-local
 * hosts because the test setup drops and recreates the database.
 */
export function testDatabaseUrls(): TestDatabaseUrls {
  loadLocalEnv();
  const owner = requireUrl('MIGRATION_DATABASE_URL');
  const app = requireUrl('DATABASE_URL');

  for (const url of [owner, app]) {
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(`Refusing to run integration tests against non-local host "${url.hostname}".`);
    }
  }

  const maintenance = owner.toString();
  owner.pathname = `/${TEST_DATABASE}`;
  app.pathname = `/${TEST_DATABASE}`;
  return { maintenance, owner: owner.toString(), app: app.toString() };
}
