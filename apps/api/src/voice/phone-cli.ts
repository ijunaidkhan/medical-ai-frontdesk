/**
 * Connects phone numbers to practices. Run by the operator, not by practices.
 *
 *   npm run phone -- add --practice alpha --number +14155550123 --label "Main line"
 *   npm run phone -- list
 *   npm run phone -- disable --number +14155550123
 *
 * Uses the schema-owner connection (MIGRATION_DATABASE_URL), like `npm run bootstrap`.
 */
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from '../database/database.types.js';
import { addPhoneNumber, listPhoneNumbers, parsePhoneArgs, PhoneAdminError, setPhoneNumberActive } from './phone-admin.js';

function loadLocalEnv(): void {
  for (const path of ['.env', resolve(process.cwd(), '../../.env')]) {
    try {
      process.loadEnvFile(path);
    } catch {
      // Absent: variables may come from the real environment.
    }
  }
}

async function main(): Promise<void> {
  const command = parsePhoneArgs(process.argv.slice(2));
  loadLocalEnv();
  const connectionString = process.env['MIGRATION_DATABASE_URL'];
  if (!connectionString) {
    throw new PhoneAdminError('MIGRATION_DATABASE_URL is not set (see .env.example).');
  }

  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }) });
  try {
    switch (command.command) {
      case 'add': {
        await addPhoneNumber(db, command);
        console.log(`Connected ${command.number} to "${command.practice}". Calls to it will reach that practice's AI receptionist once voice is turned on.`);
        break;
      }
      case 'enable':
      case 'disable': {
        await setPhoneNumberActive(db, command.number, command.command === 'enable');
        console.log(`${command.number} is now ${command.command === 'enable' ? 'on' : 'off'}.`);
        break;
      }
      case 'list': {
        const numbers = await listPhoneNumbers(db);
        if (numbers.length === 0) console.log('No phone numbers are connected yet.');
        for (const n of numbers) console.log(`${n.number}  ${n.active ? 'on ' : 'off'}  ${n.practice}${n.label ? `  (${n.label})` : ''}`);
        break;
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof PhoneAdminError ? error.message : error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
