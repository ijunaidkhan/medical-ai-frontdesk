import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@frontdesk/shared';
import { isEmail } from 'class-validator';
import type { Kysely } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import { isKnownTimezone } from '../common/timezone.js';
import type { Database } from '../database/database.types.js';
import type { PasswordHasher } from './password-hasher.js';

export interface BootstrapInput {
  practiceName: string;
  practiceSlug: string;
  /** IANA time zone, e.g. "America/New_York". */
  timezone: string;
  ownerEmail: string;
  ownerDisplayName: string;
  password: string;
}

export class BootstrapValidationError extends Error {}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // drop accents left over from decomposition ("é" -> "e")
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

/** Returns a list of problems; empty means the input is acceptable. */
export function validateBootstrapInput(input: BootstrapInput): string[] {
  const problems: string[] = [];
  const name = input.practiceName.trim();
  if (name.length < 1 || name.length > 120) {
    problems.push('Practice name must be 1-120 characters.');
  }
  if (!SLUG_PATTERN.test(input.practiceSlug)) {
    problems.push('Practice slug must be 2-63 characters: lowercase letters, digits and hyphens, starting with a letter or digit.');
  }
  if (!isKnownTimezone(input.timezone)) {
    problems.push(`Unknown time zone "${input.timezone}". Use an IANA name such as "America/New_York" or "UTC".`);
  }
  if (!isEmail(input.ownerEmail) || input.ownerEmail.length > 254) {
    problems.push('Owner email is not a valid email address.');
  }
  const displayName = input.ownerDisplayName.trim();
  if (displayName.length < 1 || displayName.length > 120) {
    problems.push('Owner name must be 1-120 characters.');
  }
  if (input.password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (input.password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (input.password.toLowerCase() === input.ownerEmail.toLowerCase()) {
    problems.push('Password must not be the same as the email address.');
  }
  return problems;
}

/**
 * Creates a practice (tenant) and its first owner in one transaction, and
 * records it in the audit log. Everything is rolled back if any step fails.
 *
 * Must be given the schema-owner connection: the API's runtime role
 * deliberately cannot create practices or users.
 */
export async function createPracticeWithOwner(
  ownerDb: Kysely<Database>,
  hasher: PasswordHasher,
  input: BootstrapInput,
): Promise<{ practiceId: string; userId: string }> {
  const problems = validateBootstrapInput(input);
  if (problems.length > 0) {
    throw new BootstrapValidationError(problems.join('\n'));
  }
  const passwordHash = await hasher.hash(input.password);

  return ownerDb.transaction().execute(async (trx) => {
    const practice = await trx
      .insertInto('practices')
      .values({ name: input.practiceName.trim(), slug: input.practiceSlug, timezone: input.timezone, phone: null })
      .returning('id')
      .executeTakeFirstOrThrow();

    const user = await trx
      .insertInto('users')
      .values({
        email: input.ownerEmail.trim(),
        password_hash: passwordHash,
        display_name: input.ownerDisplayName.trim(),
        locked_until: null,
        last_login_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx.insertInto('memberships').values({ practice_id: practice.id, user_id: user.id, role: 'owner' }).execute();

    await writeAuditLog(trx, {
      practiceId: practice.id,
      actorUserId: user.id,
      action: 'bootstrap.practice_created',
      targetType: 'practice',
      targetId: practice.id,
      metadata: { slug: input.practiceSlug },
    });

    return { practiceId: practice.id, userId: user.id };
  });
}
