import type { TimeFormat } from '@frontdesk/shared';

/**
 * Dates and times on the PRACTICE's clock, whatever the computer's own time zone is.
 * Staff type "5 October, 09:00" meaning the clinic's 09:00; these helpers turn that into
 * the exact instant the API stores, and back.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); // unknown zone: the browser's
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** What the practice's wall clock shows at `at`: "2026-10-05" and "09:00". */
export function localParts(at: Date | string, timeZone: string): { date: string; time: string } {
  const instant = typeof at === 'string' ? new Date(at) : at;
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { date: `${read('year')}-${pad(read('month'))}-${pad(read('day'))}`, time: `${pad(read('hour') % 24)}:${pad(read('minute'))}` };
}

/** Today's date on the practice's calendar. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return localParts(now, timeZone).date;
}

/** "2026-10-05" plus `days` (negative goes back). Plain calendar arithmetic. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const moved = new Date(Date.UTC(year!, month! - 1, day! + days));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** The Monday on or before a date (weeks start on Monday, like the hours editor). */
export function mondayOf(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/**
 * The instant at which the practice's clock shows `date` `time` ("2026-10-05", "09:00"), or null when
 * either is not a real date or time, or when that time does not exist that day (the clocks went forward).
 */
export function zonedInstant(date: string, time: string, timeZone: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!dateMatch || !timeMatch) return null;
  const [year, month, day] = [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const wanted = Date.UTC(year, month - 1, day, Number(timeMatch[1]), Number(timeMatch[2]));
  // Guess the instant as if the clock were UTC, then correct by the zone's offset (twice, for daylight saving edges).
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const shown = localParts(new Date(guess), timeZone);
    const shownMs = Date.parse(`${shown.date}T${shown.time}:00Z`);
    guess += wanted - shownMs;
  }
  const result = new Date(guess);
  const shown = localParts(result, timeZone);
  return shown.date === date && shown.time === time ? result : null;
}

/** "9:00 AM" or "09:00" on the practice's clock. */
export function formatClock(at: Date | string, timeZone: string, format: TimeFormat): string {
  const { time } = localParts(at, timeZone);
  if (format === '24h') return time;
  const [hour, minute] = time.split(':').map(Number);
  return `${hour! % 12 === 0 ? 12 : hour! % 12}:${pad(minute!)} ${hour! < 12 ? 'AM' : 'PM'}`;
}

/** "Monday 5 October" for a calendar date (no time zone involved: it is already the practice's date). */
export function formatDayHeading(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/** "Mon 5 Oct, 9:00 AM" on the practice's clock: for lists where the date changes from line to line. */
export function formatWhen(at: Date | string, timeZone: string, format: TimeFormat): string {
  const { date } = localParts(at, timeZone);
  const [year, month, day] = date.split('-').map(Number);
  const dayText = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(year!, month! - 1, day!)));
  return `${dayText}, ${formatClock(at, timeZone, format)}`;
}
