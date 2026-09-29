import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type Kysely, sql } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

const UP_SUFFIX = '.up.sql';
const DOWN_SUFFIX = '.down.sql';

/** apps/api/migrations, reachable from both src/ (tests) and dist/ (production). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Reads plain SQL migrations named `<order>_<name>.up.sql` with an optional
 * matching `.down.sql`. Migrations run in file-name order, each in a transaction.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly directory: string = MIGRATIONS_DIR) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = await readdir(this.directory);
    const names = files
      .filter((file) => file.endsWith(UP_SUFFIX))
      .map((file) => file.slice(0, -UP_SUFFIX.length))
      .sort();

    const migrations: Record<string, Migration> = {};
    for (const name of names) {
      const upPath = `${this.directory}/${name}${UP_SUFFIX}`;
      const downPath = `${this.directory}/${name}${DOWN_SUFFIX}`;
      const hasDown = files.includes(`${name}${DOWN_SUFFIX}`);
      migrations[name] = {
        up: async (db) => {
          await sql.raw(await readFile(upPath, 'utf8')).execute(db);
        },
        ...(hasDown && {
          down: async (db) => {
            await sql.raw(await readFile(downPath, 'utf8')).execute(db);
          },
        }),
      };
    }
    return migrations;
  }
}

export function createMigrator(db: Kysely<unknown>, directory?: string): Migrator {
  return new Migrator({ db, provider: new SqlFileMigrationProvider(directory) });
}
