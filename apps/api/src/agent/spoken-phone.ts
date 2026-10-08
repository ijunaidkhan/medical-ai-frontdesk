import type { Kysely } from 'kysely';
import type { Database } from '../database/database.types.js';

/**
 * A phone number the receptionist saves (on a patient or in a message for staff) must be one the caller
 * actually said. Models drop, repeat or invent digits when they copy a number, and a wrong number cannot
 * be called back.
 */

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

/** Whether the caller said this phone number anywhere in this conversation. Run inside the practice's transaction. */
export async function callerSaidPhone(db: Kysely<Database>, conversationId: string, phone: string): Promise<boolean> {
  const said = await db.selectFrom('conversation_turns').select('text').where('conversation_id', '=', conversationId).where('speaker', '=', 'caller').execute();
  return phoneWasSaid(phone, said.map((turn) => turn.text).join(' '));
}

/** What the model is told when the number it passed is not one the caller said. */
export const phoneNotSaidMessage = (phone: string): string =>
  `The phone number ${phone} is not what the caller said. Copy the caller's phone number exactly, digit by digit, with the country code, or ask them to say it again.`;
