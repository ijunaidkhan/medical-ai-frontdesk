import { PHONE_PATTERN } from '@frontdesk/shared';
import type { Kysely } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { Database } from '../database/database.types.js';

/** Something the operator can fix: the message is written for them. */
export class PhoneAdminError extends Error {}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
const UNIQUE_VIOLATION = '23505';

export interface AddPhoneNumberInput {
  /** The practice's short name (its slug). */
  practice: string;
  /** International format, e.g. +14155550123. */
  number: string;
  label?: string;
  /** Twilio's id for the number (starts with "PN"); optional, for the operator's own reference. */
  providerSid?: string;
}

function checkNumber(number: string): void {
  if (!PHONE_PATTERN.test(number)) {
    throw new PhoneAdminError(`"${number}" is not an international phone number. Use the country code, for example +14155550123.`);
  }
}

/**
 * Connects a phone number to a practice. Runs with the schema owner's rights (the
 * operator's command): practices cannot add numbers themselves, so nobody can
 * claim another clinic's number. One number belongs to one practice.
 */
export async function addPhoneNumber(db: Kysely<Database>, input: AddPhoneNumberInput): Promise<{ id: string; practiceId: string }> {
  checkNumber(input.number);
  if (!SLUG_PATTERN.test(input.practice)) {
    throw new PhoneAdminError('Practice short name must be lowercase letters, digits and hyphens.');
  }
  const label = (input.label ?? '').trim();
  if (label.length > 80) {
    throw new PhoneAdminError('The label must be at most 80 characters.');
  }
  if (input.providerSid !== undefined && !SID_PATTERN.test(input.providerSid)) {
    throw new PhoneAdminError('The Twilio id must be letters and digits only (it starts with "PN").');
  }

  try {
    return await db.transaction().execute(async (trx) => {
      const practice = await trx.selectFrom('practices').select('id').where('slug', '=', input.practice).executeTakeFirst();
      if (!practice) {
        throw new PhoneAdminError(`There is no practice with the short name "${input.practice}".`);
      }
      const row = await trx
        .insertInto('phone_numbers')
        .values({ practice_id: practice.id, e164: input.number, label, provider_sid: input.providerSid ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeAuditLog(trx, {
        practiceId: practice.id,
        actorUserId: null,
        actorType: 'system',
        action: 'phone_number.added',
        targetType: 'phone_number',
        targetId: row.id,
        metadata: { provider: 'twilio' },
      });
      return { id: row.id, practiceId: practice.id };
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === UNIQUE_VIOLATION) {
      throw new PhoneAdminError(`${input.number} is already connected to a practice.`);
    }
    throw error;
  }
}

/** Switches a number on or off. A switched-off number does not answer calls. */
export async function setPhoneNumberActive(db: Kysely<Database>, number: string, active: boolean): Promise<void> {
  checkNumber(number);
  await db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom('phone_numbers').select(['id', 'practice_id', 'active']).where('e164', '=', number).forUpdate().executeTakeFirst();
    if (!current) {
      throw new PhoneAdminError(`${number} is not connected to any practice.`);
    }
    if (current.active === active) {
      throw new PhoneAdminError(`${number} is already ${active ? 'on' : 'off'}.`);
    }
    await trx.updateTable('phone_numbers').set({ active }).where('id', '=', current.id).execute();
    await writeAuditLog(trx, {
      practiceId: current.practice_id,
      actorUserId: null,
      actorType: 'system',
      action: active ? 'phone_number.enabled' : 'phone_number.disabled',
      targetType: 'phone_number',
      targetId: current.id,
    });
  });
}

export interface ListedNumber {
  number: string;
  practice: string;
  label: string;
  active: boolean;
}

export async function listPhoneNumbers(db: Kysely<Database>): Promise<ListedNumber[]> {
  const rows = await db
    .selectFrom('phone_numbers as n')
    .innerJoin('practices as p', 'p.id', 'n.practice_id')
    .select(['n.e164', 'p.slug', 'n.label', 'n.active'])
    .orderBy('p.slug')
    .orderBy('n.e164')
    .execute();
  return rows.map((row) => ({ number: row.e164, practice: row.slug, label: row.label, active: row.active }));
}

// ------------------------------------------------------------------ command line

export type PhoneCommand =
  | { command: 'add'; practice: string; number: string; label?: string; providerSid?: string }
  | { command: 'enable' | 'disable'; number: string }
  | { command: 'list' };

export const PHONE_USAGE = `Usage:
  npm run phone -- add --practice <short-name> --number <+14155550123> [--label "Main line"] [--sid PNxxxxxxxx]
  npm run phone -- list
  npm run phone -- enable  --number <+14155550123>
  npm run phone -- disable --number <+14155550123>`;

/** Reads the command line. Anything unexpected is an error with the usage text, never silently ignored. */
export function parsePhoneArgs(argv: readonly string[]): PhoneCommand {
  const [command, ...rest] = argv;
  const allowed: Record<string, readonly string[]> = { add: ['practice', 'number', 'label', 'sid'], enable: ['number'], disable: ['number'], list: [] };
  if (command === undefined || !(command in allowed)) {
    throw new PhoneAdminError(PHONE_USAGE);
  }

  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? '';
    const value = rest[i + 1];
    const name = flag.startsWith('--') ? flag.slice(2) : '';
    if (!allowed[command]!.includes(name) || value === undefined || value.startsWith('--') || options.has(name)) {
      throw new PhoneAdminError(`Unexpected or incomplete option "${flag}".\n${PHONE_USAGE}`);
    }
    options.set(name, value);
  }

  const need = (name: string): string => {
    const value = options.get(name);
    if (value === undefined) throw new PhoneAdminError(`Missing --${name}.\n${PHONE_USAGE}`);
    return value;
  };
  if (command === 'list') return { command: 'list' };
  if (command === 'enable' || command === 'disable') return { command, number: need('number') };
  const label = options.get('label');
  const providerSid = options.get('sid');
  return {
    command: 'add',
    practice: need('practice'),
    number: need('number'),
    ...(label !== undefined && { label }),
    ...(providerSid !== undefined && { providerSid }),
  };
}
