import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

/** A fully migrated, never-used database that every test file copies. */
export const TEMPLATE_DATABASE = 'frontdesk_test_template';
export const TEST_DATABASE_PREFIX = 'frontdesk_test_';

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

export function withDatabase(url: string, database: string): string {
  const copy = new URL(url);
  copy.pathname = `/${database}`;
  return copy.toString();
}

export interface BaseUrls {
  /** Schema-owner credentials (creates databases, runs migrations, seeds data). */
  owner: string;
  /** API runtime-role credentials: the ones whose isolation is under test. */
  app: string;
}

/**
 * Credentials from the environment, checked to be local because the test setup
 * creates and drops databases. The database name in these URLs is ignored.
 */
export function baseUrls(): BaseUrls {
  loadLocalEnv();
  const owner = requireUrl('MIGRATION_DATABASE_URL');
  const app = requireUrl('DATABASE_URL');
  for (const url of [owner, app]) {
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(`Refusing to run integration tests against non-local host "${url.hostname}".`);
    }
  }
  return { owner: owner.toString(), app: app.toString() };
}

/** Connection for CREATE/DROP DATABASE, made to the built-in "postgres" database. */
async function withAdminClient<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(baseUrls().owner, 'postgres') });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function dropStaleTestDatabases(): Promise<void> {
  await withAdminClient(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'frontdesk\\_test%'`,
    );
    for (const { datname } of rows) {
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  });
}

export async function createTemplateDatabase(): Promise<string> {
  await withAdminClient((client) => client.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`));
  return withDatabase(baseUrls().owner, TEMPLATE_DATABASE);
}

export interface IsolatedDatabase {
  name: string;
  ownerUrl: string;
  appUrl: string;
  drop(): Promise<void>;
}

/** A private, freshly migrated database for one test file. Call drop() in afterAll. */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const name = `${TEST_DATABASE_PREFIX}${randomBytes(6).toString('hex')}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`));
  const { owner, app } = baseUrls();
  return {
    name,
    ownerUrl: withDatabase(owner, name),
    appUrl: withDatabase(app, name),
    drop: () => withAdminClient((client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => undefined),
  };
}
