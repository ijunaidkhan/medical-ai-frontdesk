import { WEEKDAYS, type Weekday } from '@frontdesk/shared';

/** A calendar date with no time zone attached ("1 October 2026"). */
export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * What a wall clock in `timeZone` reads at `instant`, written as a plain number of
 * milliseconds as if that reading were UTC. Two readings can be compared and
 * subtracted without any time zone arithmetic.
 */
export function wallClockMs(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/** The calendar date it is in `timeZone` at `instant`. */
export function localDate(instant: Date, timeZone: string): CalendarDate {
  const wall = new Date(wallClockMs(instant, timeZone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

/** The date `days` after (or before, if negative) `date`. Plain calendar arithmetic. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

export function weekdayOf(date: CalendarDate): Weekday {
  const sundayFirst = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(sundayFirst + 6) % 7]!; // WEEKDAYS starts on Monday
}

/** Milliseconds a wall clock reading of `minutes` after midnight on `date` would have, as if it were UTC. */
export function wallClockOf(date: CalendarDate, minutes: number): number {
  return Date.UTC(date.year, date.month - 1, date.day) + minutes * 60_000;
}

/**
 * The instant at which the wall clock in `timeZone` reads `minutes` after midnight on `date`.
 *
 *  - Daylight saving can make a local time not exist (the clocks jump forward): then null.
 *  - It can also make a local time happen twice (the clocks go back): then the earlier instant.
 *
 * `minutes` may be 1440 or more (the next day).
 */
export function zonedInstant(date: CalendarDate, minutes: number, timeZone: string): Date | null {
  const wanted = wallClockOf(date, minutes);
  // The offset from UTC differs by at most an hour or two around a change, so look at the offsets a day either side.
  const candidates = new Set<number>();
  for (const probe of [-86_400_000, 0, 86_400_000]) {
    const offset = wallClockMs(new Date(wanted + probe), timeZone) - (wanted + probe);
    candidates.add(wanted - offset);
  }
  const valid = [...candidates].filter((ms) => wallClockMs(new Date(ms), timeZone) === wanted).sort((a, b) => a - b);
  return valid.length === 0 ? null : new Date(valid[0]!);
}
