import { addDays, formatClock, formatDayHeading, formatWhen, localParts, mondayOf, todayIn, zonedInstant } from './zoned-time';

describe('zoned time (the practice’s clock, not the computer’s)', () => {
  it('reads the wall clock in a practice’s time zone', () => {
    expect(localParts('2026-10-05T04:00:00Z', 'Asia/Karachi')).toEqual({ date: '2026-10-05', time: '09:00' });
    expect(localParts('2026-10-05T13:00:00Z', 'America/New_York')).toEqual({ date: '2026-10-05', time: '09:00' }); // summer time
    expect(localParts('2026-12-07T14:00:00Z', 'America/New_York')).toEqual({ date: '2026-12-07', time: '09:00' }); // winter time
    expect(localParts('2026-10-05T22:30:00Z', 'Asia/Karachi')).toEqual({ date: '2026-10-06', time: '03:30' }); // a different date than UTC
  });

  it('turns a practice date and time into the exact instant, both ways round', () => {
    expect(zonedInstant('2026-10-05', '09:00', 'Asia/Karachi')?.toISOString()).toBe('2026-10-05T04:00:00.000Z');
    expect(zonedInstant('2026-10-05', '09:00', 'America/New_York')?.toISOString()).toBe('2026-10-05T13:00:00.000Z');
    expect(zonedInstant('2026-12-07', '09:00', 'America/New_York')?.toISOString()).toBe('2026-12-07T14:00:00.000Z');
    expect(zonedInstant('2026-10-05', '05:30', 'Asia/Kolkata')?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(zonedInstant('2026-10-05', '00:00', 'UTC')?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('refuses times that do not exist (the clocks went forward) and dates or times that are not real', () => {
    expect(zonedInstant('2026-03-08', '02:30', 'America/New_York')).toBeNull();
    expect(zonedInstant('2026-02-30', '09:00', 'UTC')).toBeNull();
    expect(zonedInstant('2026-10-05', '24:00', 'UTC')).toBeNull();
    expect(zonedInstant('2026-10-05', '9:00', 'UTC')).toBeNull();
    expect(zonedInstant('5 Oct', '09:00', 'UTC')).toBeNull();
  });

  it('finds times just after the clocks went forward (the offset changes between guesses)', () => {
    expect(zonedInstant('2026-03-08', '03:30', 'America/New_York')?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedInstant('2026-03-08', '09:00', 'America/New_York')?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('takes the earlier of a time that happens twice (the clocks went back)', () => {
    expect(zonedInstant('2026-11-01', '01:30', 'America/New_York')?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('does calendar arithmetic and finds the Monday of a week', () => {
    expect(addDays('2026-10-05', 1)).toBe('2026-10-06');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(mondayOf('2026-10-05')).toBe('2026-10-05'); // a Monday
    expect(mondayOf('2026-10-11')).toBe('2026-10-05'); // the Sunday after it
    expect(mondayOf('2026-10-07')).toBe('2026-10-05');
    expect(todayIn('Asia/Karachi', new Date('2026-10-05T22:30:00Z'))).toBe('2026-10-06');
  });

  it('writes times on a 12-hour or 24-hour clock, as the practice chose', () => {
    expect(formatClock('2026-10-05T04:00:00Z', 'Asia/Karachi', '12h')).toBe('9:00 AM');
    expect(formatClock('2026-10-05T09:30:00Z', 'Asia/Karachi', '12h')).toBe('2:30 PM');
    expect(formatClock('2026-10-05T09:30:00Z', 'Asia/Karachi', '24h')).toBe('14:30');
    expect(formatClock('2026-10-05T00:00:00Z', 'UTC', '12h')).toBe('12:00 AM');
    expect(formatClock('2026-10-05T12:00:00Z', 'UTC', '12h')).toBe('12:00 PM');
    expect(formatWhen('2026-10-05T04:00:00Z', 'Asia/Karachi', '24h')).toBe('Mon 5 Oct, 09:00');
    expect(formatDayHeading('2026-10-05')).toBe('Monday 5 October');
  });
});
