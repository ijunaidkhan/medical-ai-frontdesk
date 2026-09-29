/**
 * Creates the first practice and its owner account.
 *
 *   npm run bootstrap
 *
 * Uses the schema-owner connection (MIGRATION_DATABASE_URL). The password is
 * typed at a hidden prompt and is never written to disk, logged, or put in
 * shell history. When stdin is not a terminal (automation), answers are read
 * from lines on stdin, in the same order as the prompts.
 */
import { resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from '../database/database.types.js';
import { BootstrapValidationError, createPracticeWithOwner, slugify, validateBootstrapInput } from './bootstrap.js';
import { PasswordHasher } from './password-hasher.js';

function loadLocalEnv(): void {
  for (const path of ['.env', resolve(process.cwd(), '../../.env')]) {
    try {
      process.loadEnvFile(path);
    } catch {
      // Absent: variables may come from the real environment.
    }
  }
}

/** Reads answers either from a terminal (with optional hidden input) or, when piped, line by line. */
class Prompter {
  private queued: string[] | undefined;

  private async pipedLines(): Promise<string[]> {
    if (!this.queued) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      this.queued = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    }
    return this.queued;
  }

  async ask(question: string, options: { hidden?: boolean; fallback?: string } = {}): Promise<string> {
    const suffix = options.fallback ? ` [${options.fallback}]` : '';
    process.stdout.write(`${question}${suffix}: `);

    let answer: string;
    if (process.stdin.isTTY) {
      answer = await this.readFromTerminal(options.hidden === true);
    } else {
      answer = (await this.pipedLines()).shift() ?? '';
      process.stdout.write('\n');
    }
    return answer === '' && options.fallback !== undefined ? options.fallback : answer;
  }

  private readFromTerminal(hidden: boolean): Promise<string> {
    return new Promise((resolveAnswer, reject) => {
      const stdin = process.stdin;
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      let value = '';

      const finish = (action: () => void) => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('keypress', onKey);
        process.stdout.write('\n');
        action();
      };
      const onKey = (character: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
        if (key?.ctrl && key.name === 'c') {
          finish(() => reject(new Error('Cancelled.')));
        } else if (key?.name === 'return' || key?.name === 'enter') {
          finish(() => resolveAnswer(value));
        } else if (key?.name === 'backspace') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!hidden) process.stdout.write('\b \b');
          }
        } else if (character && !key?.ctrl && character >= ' ') {
          value += character;
          if (!hidden) process.stdout.write(character);
        }
      };
      stdin.on('keypress', onKey);
    });
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const connectionString = process.env['MIGRATION_DATABASE_URL'];
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL is not set (see .env.example).');
  }

  const prompter = new Prompter();
  console.log('Create the first practice and its owner account.\n');

  const practiceName = await prompter.ask('Practice name');
  const practiceSlug = await prompter.ask('Practice short name (letters, digits, hyphens)', { fallback: slugify(practiceName) });
  const timezone = await prompter.ask('Practice time zone', { fallback: 'UTC' });
  const ownerDisplayName = await prompter.ask('Your name');
  const ownerEmail = await prompter.ask('Your email (used to sign in)');
  const password = await prompter.ask('Password (at least 15 characters; input is hidden)', { hidden: true });
  const confirmation = await prompter.ask('Repeat password', { hidden: true });

  if (password !== confirmation) {
    throw new BootstrapValidationError('The two passwords do not match.');
  }
  const input = { practiceName, practiceSlug, timezone, ownerEmail, ownerDisplayName, password };
  const problems = validateBootstrapInput(input);
  if (problems.length > 0) {
    throw new BootstrapValidationError(problems.join('\n'));
  }

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });
  try {
    const { practiceId } = await createPracticeWithOwner(db, new PasswordHasher(), input);
    console.log(`\nCreated practice "${practiceName.trim()}" (${practiceId}) with owner ${ownerEmail.trim()}.`);
    console.log('You can now sign in.');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  if (error instanceof BootstrapValidationError) {
    console.error(`\nNot created:\n${error.message}`);
  } else if (error instanceof Error && 'code' in error && error.code === '23505') {
    console.error('\nNot created: that email address or practice short name is already in use.');
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
