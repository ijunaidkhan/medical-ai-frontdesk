import type { Kysely } from 'kysely';
import type { Database } from '../database/database.types.js';
import { callerWords } from './caller-words.js';

/**
 * A date of birth the receptionist saves must be one the caller said. Speech recognition garbles dates and models
 * invent them, and a wrong date of birth finds the wrong patient (or none). Dates are read from what the caller
 * wrote or the recogniser heard as digits ("3 February 1991", "February 3rd, 1991", "3/2/1991", "1991-02-03").
 * Dates spelled out in words ("third of February nineteen ninety one") are not recognised.
 */

const MONTHS: Readonly<Record<string, number>> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
/** Longest names first, so "sept" is not read as "sep" followed by a stray "t". */
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const ORDINAL = '(?:st|nd|rd|th)?';

/** A date as the caller said it. The year keeps its digits: "91" and "1991" are different ways to say one year. */
interface SaidDate {
  year: string;
  month: number;
  day: number;
}

const DAY_MONTH_YEAR = new RegExp(`(?<!\\d)(\\d{1,2})${ORDINAL}\\s*(?:of\\s+)?\\b(${MONTH})\\b\\.?,?\\s*(\\d{4}|\\d{2})(?!\\d)`, 'g');
const MONTH_DAY_YEAR = new RegExp(`\\b(${MONTH})\\b\\.?\\s*(\\d{1,2})${ORDINAL},?\\s*(\\d{4}|\\d{2})(?!\\d)`, 'g');
const YEAR_MONTH_DAY = new RegExp(`(?<!\\d)(\\d{4})\\s*,?\\s*\\b(${MONTH})\\b\\.?\\s*(\\d{1,2})${ORDINAL}(?!\\d)`, 'g');
const THREE_NUMBERS = /(?<!\d)(\d{1,4})\s*[/.,\-\s]\s*(\d{1,2})\s*[/.,\-\s]\s*(\d{1,4})(?!\d)/g;

function datesSaid(text: string): SaidDate[] {
  const lower = text.toLowerCase();
  const found: SaidDate[] = [];
  for (const [, day, month, year] of lower.matchAll(DAY_MONTH_YEAR)) found.push({ year: year!, month: MONTHS[month!]!, day: Number(day) });
  for (const [, month, day, year] of lower.matchAll(MONTH_DAY_YEAR)) found.push({ year: year!, month: MONTHS[month!]!, day: Number(day) });
  for (const [, year, month, day] of lower.matchAll(YEAR_MONTH_DAY)) found.push({ year: year!, month: MONTHS[month!]!, day: Number(day) });
  for (const [, first, second, third] of lower.matchAll(THREE_NUMBERS)) {
    // The order is not known (3/2/1991 is the 3rd of February or the 2nd of March): both readings count.
    const [a, b, c] = [first!, second!, third!];
    if (a.length === 4) {
      found.push({ year: a, month: Number(b), day: Number(c) }, { year: a, month: Number(c), day: Number(b) });
    } else if (c.length === 4 || c.length === 2) {
      found.push({ year: c, month: Number(b), day: Number(a) }, { year: c, month: Number(a), day: Number(b) });
    }
  }
  return found;
}

const yearMatches = (year: number, said: string): boolean => (said.length === 4 ? Number(said) === year : said.length === 2 && Number(said) === year % 100);

/** Whether the date (written YYYY-MM-DD) is one the caller said. Anything else, including a malformed date, is not. */
export function dateWasSaid(isoDate: string, callerWords: string): boolean {
  const target = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!target) return false;
  const [year, month, day] = [Number(target[1]), Number(target[2]), Number(target[3])];
  return datesSaid(callerWords).some((said) => said.month === month && said.day === day && yearMatches(year, said.year));
}

/** Whether the caller said this date of birth anywhere in this conversation. Run inside the practice's transaction. */
export async function callerSaidDate(db: Kysely<Database>, conversationId: string, isoDate: string): Promise<boolean> {
  return dateWasSaid(isoDate, await callerWords(db, conversationId));
}

/** What the model is told when the date it passed is not one the caller said. */
export const dateNotSaidMessage = (isoDate: string): string =>
  `The date of birth ${isoDate} is not what the caller said. Ask the caller to say their date of birth again, then give it to the tool as YYYY-MM-DD, exactly as they said it.`;
