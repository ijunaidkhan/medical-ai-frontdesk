import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createPracticeWithOwner } from '../../src/auth/bootstrap.js';
import { PasswordHasher } from '../../src/auth/password-hasher.js';
import type { Db } from '../../src/database/database.module.js';
import type { Database } from '../../src/database/database.types.js';
import type { Role } from '@frontdesk/shared';

/** Not a real credential: used only against throwaway test databases. */
export const TEST_PASSWORD = 'correct horse battery staple 42';

export const hasher = new PasswordHasher();

export function connect(url: string, max = 2): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max }) }) });
}

export interface SeededPractice {
  practiceId: string;
  ownerId: string;
  ownerEmail: string;
}

/** A practice with an owner who can sign in with TEST_PASSWORD. */
export async function seedPractice(ownerDb: Db, slug: string, ownerEmail = `owner@${slug}.test`): Promise<SeededPractice> {
  const { practiceId, userId } = await createPracticeWithOwner(ownerDb, hasher, {
    practiceName: `Practice ${slug}`,
    practiceSlug: slug,
    timezone: 'UTC',
    ownerEmail,
    ownerDisplayName: `Owner of ${slug}`,
    password: TEST_PASSWORD,
  });
  return { practiceId, ownerId: userId, ownerEmail };
}

/** Adds a member to a practice. Creates the user unless one with that email exists. */
export async function addMember(
  ownerDb: Db,
  practiceId: string,
  email: string,
  role: Role,
): Promise<string> {
  const existing = await ownerDb.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  const userId =
    existing?.id ??
    (
      await ownerDb
        .insertInto('users')
        .values({
          email,
          password_hash: await hasher.hash(TEST_PASSWORD),
          display_name: `Member ${email}`,
          locked_until: null,
          last_login_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  await ownerDb.insertInto('memberships').values({ practice_id: practiceId, user_id: userId, role }).execute();
  return userId;
}
