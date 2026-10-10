import { PHONE_PATTERN } from '@frontdesk/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../database/database.types.js';
import { callerWords } from './caller-words.js';

/**
 * A phone number the receptionist saves (on a patient or in a message for staff) must be one the caller
 * actually said. Models drop, repeat or invent digits when they copy a number, and a wrong number cannot
 * be called back.
 */

/** Speech recognition and models write phone numbers with spaces and dashes; the stored form has none. */
export const normalizePhone = (text: string): string => text.replace(/[\s\-().]/g, '');

/**
 * Said to the model when the number it wrote is still not in the stored form. Without it, a small model blames the
 * caller and asks them to "confirm" the number again and again, however correctly they said it.
 */
export const PHONE_FORMAT_NOTE =
  'Write the number yourself as a plus sign, the country code, then the number. Spaces and dashes are removed for you, so never ask the caller to say it differently. Ask again only if the caller has not said the country code or all of the digits.';

const SPOKEN_DIGITS: Record<string, string> = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/** Each number in what someone said, as its digits: "+1 (415) 555-0111" and "four one five, five five five, ..." are one number each. */
function numbersSaid(text: string): Array<{ digits: string; international: boolean }> {
  const figures = text.toLowerCase().replace(/\b(zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/g, (word) => SPOKEN_DIGITS[word]!);
  return [...figures.matchAll(/\+?\d[\d\s().,-]*\d/g)].map((match) => ({ digits: match[0].replace(/\D/g, ''), international: match[0].startsWith('+') }));
}

/**
 * Whether the caller said this phone number: one of the numbers they said must be exactly it, or exactly it
 * without the country code (people say "415 555 0111", or "0300 1234567" with the local 0 for +923001234567).
 * A number with a digit missing, added or changed does not match.
 */
export function phoneWasSaid(phone: string, callerWords: string): boolean {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return false;
  return numbersSaid(callerWords).some((said) => {
    if (said.digits === digits) return true;
    // Only a number said WITHOUT a country code may have one added (1 to 3 digits); one said with "+" must match exactly.
    if (said.international) return false;
    const national = said.digits.replace(/^0/, '');
    return national.length >= 7 && digits.endsWith(national) && digits.length - national.length <= 3;
  });
}

/**
 * The one phone number the caller said in full, with its country code ("+1 415 555 0177"), as +digits; null when they said
 * none or two different ones. It spares a caller who already gave their number from being asked again. A number said
 * without a plus sign is not used: its country code is not known.
 */
export function volunteeredPhone(callerWords: string): string | null {
  const numbers = new Set(
    numbersSaid(callerWords)
      .filter((said) => said.international && PHONE_PATTERN.test(`+${said.digits}`))
      .map((said) => `+${said.digits}`),
  );
  return numbers.size === 1 ? [...numbers][0]! : null;
}

/** The number the caller volunteered anywhere in this conversation (see volunteeredPhone). Run inside the practice's transaction. */
export async function callerVolunteeredPhone(db: Kysely<Database>, conversationId: string): Promise<string | null> {
  return volunteeredPhone(await callerWords(db, conversationId));
}

/** Whether the caller said this phone number anywhere in this conversation. Run inside the practice's transaction. */
export async function callerSaidPhone(db: Kysely<Database>, conversationId: string, phone: string): Promise<boolean> {
  return phoneWasSaid(phone, await callerWords(db, conversationId));
}

/** What the model is told when the number it passed is not one the caller said. */
export const phoneNotSaidMessage = (phone: string): string =>
  `The phone number ${phone} is not what the caller said. Copy the caller's phone number exactly, digit by digit, with the country code, or ask them to say it again.`;
