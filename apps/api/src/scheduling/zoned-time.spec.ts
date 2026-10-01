import { addDays, localDate, wallClockMs, weekdayOf, zonedInstant } from './zoned-time.js';

const iso = (date: Date | null) => date?.toISOString() ?? null;

describe('calendar arithmetic', () => {
  it.each([
    [{ year: 2026, month: 10, day: 1 }, 1, { year: 2026, month: 10, day: 2 }],
    [{ year: 2026, month: 10, day: 31 }, 1, { year: 2026, month: 11, day: 1 }],
    [{ year: 2026, month: 12, day: 31 }, 1, { year: 2027, month: 1, day: 1 }],
    [{ year: 2028, month: 2, day: 28 }, 1, { year: 2028, month: 2, day: 29 }], // a leap year
    [{ year: 2027, month: 2, day: 28 }, 1, { year: 2027, month: 3, day: 1 }],
    [{ year: 2026, month: 3, day: 1 }, -1, { year: 2026, month: 2, day: 28 }],
    [{ year: 2026, month: 10, day: 1 }, 0, { year: 2026, month: 10, day: 1 }],
    [{ year: 2026, month: 1, day: 30 }, 45, { year: 2026, month: 3, day: 16 }],
  ])('%j plus %i days is %j', (date, days, expected) => {
    expect(addDays(date, days)).toEqual(expected);
  });

  it.each([
    [{ year: 2026, month: 10, day: 1 }, 'thu'],
    [{ year: 2026, month: 10, day: 4 }, 'sun'],
    [{ year: 2026, month: 10, day: 5 }, 'mon'],
    [{ year: 2026, month: 10, day: 10 }, 'sat'],
    [{ year: 2028, month: 2, day: 29 }, 'tue'],
  ] as const)('%j is a %s', (date, weekday) => {
    expect(weekdayOf(date)).toBe(weekday);
  });
});

describe('localDate (what day it is in a time zone)', () => {
  it('the same instant can be on different days in different places', () => {
    const instant = new Date('2026-10-01T22:00:00Z');
    expect(localDate(instant, 'UTC')).toEqual({ year: 2026, month: 10, day: 1 });
    expect(localDate(instant, 'America/New_York')).toEqual({ year: 2026, month: 10, day: 1 }); // 18:00
    expect(localDate(instant, 'Asia/Karachi')).toEqual({ year: 2026, month: 10, day: 2 }); // 03:00 next day
    expect(localDate(instant, 'Pacific/Auckland')).toEqual({ year: 2026, month: 10, day: 2 });
  });

  it('wallClockMs reads the clock on the wall at that instant', () => {
    expect(new Date(wallClockMs(new Date('2026-10-01T13:00:00Z'), 'America/New_York')).toISOString()).toBe('2026-10-01T09:00:00.000Z'); // 09:00 EDT
    expect(new Date(wallClockMs(new Date('2026-01-15T13:00:00Z'), 'America/New_York')).toISOString()).toBe('2026-01-15T08:00:00.000Z'); // 08:00 EST
  });
});

describe('zonedInstant (the real moment a local time happens)', () => {
  const day = (month: number, d: number, year = 2026) => ({ year, month, day: d });

  it.each([
    ['UTC', day(10, 1), 9 * 60, '2026-10-01T09:00:00.000Z'],
    ['America/New_York', day(10, 1), 9 * 60, '2026-10-01T13:00:00.000Z'], // summer time, UTC-4
    ['America/New_York', day(1, 15), 9 * 60, '2026-01-15T14:00:00.000Z'], // winter time, UTC-5
    ['Asia/Karachi', day(10, 1), 9 * 60, '2026-10-01T04:00:00.000Z'], // UTC+5, no daylight saving
    ['Asia/Kolkata', day(10, 1), 9 * 60, '2026-10-01T03:30:00.000Z'], // a half-hour offset
    ['Europe/London', day(7, 1), 9 * 60, '2026-07-01T08:00:00.000Z'], // summer time, UTC+1
    ['Europe/London', day(12, 1), 9 * 60, '2026-12-01T09:00:00.000Z'],
    ['Pacific/Auckland', day(10, 1), 9 * 60, '2026-09-30T20:00:00.000Z'], // UTC+13 in their summer
  ])('%s, %j, minute %i -> %s', (zone, date, minutes, expected) => {
    expect(iso(zonedInstant(date, minutes, zone))).toBe(expected);
  });

  it('treats 24:00 (1440 minutes) as midnight at the start of the next day', () => {
    expect(iso(zonedInstant(day(10, 1), 24 * 60, 'UTC'))).toBe('2026-10-02T00:00:00.000Z');
    expect(iso(zonedInstant(day(10, 1), 24 * 60, 'America/New_York'))).toBe('2026-10-02T04:00:00.000Z');
  });

  describe('when the clocks jump forward (a local time that never happens)', () => {
    // New York, Sunday 8 March 2026: 02:00 became 03:00.
    it('1:59 exists, 2:30 does not, 3:00 does', () => {
      expect(iso(zonedInstant(day(3, 8), 1 * 60 + 59, 'America/New_York'))).toBe('2026-03-08T06:59:00.000Z'); // EST, UTC-5
      expect(zonedInstant(day(3, 8), 2 * 60 + 30, 'America/New_York')).toBeNull();
      expect(zonedInstant(day(3, 8), 2 * 60, 'America/New_York')).toBeNull();
      expect(iso(zonedInstant(day(3, 8), 3 * 60, 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z'); // EDT, UTC-4
    });

    it('London, Sunday 29 March 2026: 01:30 never happens', () => {
      expect(zonedInstant(day(3, 29), 1 * 60 + 30, 'Europe/London')).toBeNull();
      expect(iso(zonedInstant(day(3, 29), 2 * 60, 'Europe/London'))).toBe('2026-03-29T01:00:00.000Z');
    });

    it('a half-hour change (Lord Howe Island, Sunday 4 October 2026: 02:00 became 02:30)', () => {
      expect(zonedInstant(day(10, 4), 2 * 60 + 15, 'Australia/Lord_Howe')).toBeNull();
      expect(zonedInstant(day(10, 4), 2 * 60 + 30, 'Australia/Lord_Howe')).not.toBeNull();
    });
  });

  describe('when the clocks go back (a local time that happens twice): the earlier moment', () => {
    it('New York, Sunday 1 November 2026: 1:30 happens first in summer time, then again in winter time', () => {
      expect(iso(zonedInstant(day(11, 1), 1 * 60 + 30, 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z'); // EDT, the first 1:30
      expect(iso(zonedInstant(day(11, 1), 0, 'America/New_York'))).toBe('2026-11-01T04:00:00.000Z');
      expect(iso(zonedInstant(day(11, 1), 2 * 60, 'America/New_York'))).toBe('2026-11-01T07:00:00.000Z'); // after the change: EST
    });

    it('London, Sunday 25 October 2026', () => {
      expect(iso(zonedInstant(day(10, 25), 1 * 60 + 30, 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z'); // BST, the first 01:30
    });
  });

  it('is always consistent with the clock it was asked about', () => {
    for (const zone of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Karachi', 'Australia/Sydney', 'America/Sao_Paulo']) {
      for (let d = 0; d < 400; d += 7) {
        const date = addDays({ year: 2026, month: 1, day: 1 }, d);
        for (const minutes of [0, 90, 9 * 60, 12 * 60 + 30, 23 * 60 + 45]) {
          const instant = zonedInstant(date, minutes, zone);
          if (instant === null) continue; // a time that does not exist that day
          expect(wallClockMs(instant, zone)).toBe(Date.UTC(date.year, date.month - 1, date.day) + minutes * 60_000);
        }
      }
    }
  });
});
