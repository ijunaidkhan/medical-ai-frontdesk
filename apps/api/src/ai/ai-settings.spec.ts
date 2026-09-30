import {
  AI_DISCLOSURE,
  aiReadinessProblems,
  composeGreeting,
  emptyBusinessHours,
  hasAnyOpeningHours,
  isOpenAt,
  localTime,
  normalizeBusinessHours,
  validateBusinessHours,
  type AiConfiguration,
  type BusinessHours,
} from '@frontdesk/shared';

const weekdays = (open: string, close: string): BusinessHours => ({
  ...emptyBusinessHours(),
  mon: [{ open, close }],
  tue: [{ open, close }],
  wed: [{ open, close }],
  thu: [{ open, close }],
  fri: [{ open, close }],
});

describe('validateBusinessHours', () => {
  it.each([
    ['nothing at all (always closed)', {}],
    ['a normal week', { mon: [{ open: '09:00', close: '17:00' }], sat: [{ open: '09:00', close: '13:00' }] }],
    ['a lunch break', { mon: [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }] }],
    ['closing at midnight', { fri: [{ open: '18:00', close: '24:00' }] }],
    ['opening at midnight', { sat: [{ open: '00:00', close: '06:00' }] }],
    ['a day left empty', { sun: [] }],
    ['periods listed out of order', { mon: [{ open: '13:00', close: '17:00' }, { open: '08:00', close: '12:00' }] }],
  ])('accepts %s', (_label, hours) => {
    expect(validateBusinessHours(hours)).toBeNull();
  });

  it.each([
    ['not an object', 'mon 9-5'],
    ['null', null],
    ['an array', []],
    ['an unknown day', { monday: [] }],
    ['a day that is not a list', { mon: { open: '09:00', close: '17:00' } }],
    ['more than three periods in a day', { mon: [1, 2, 3, 4].map((n) => ({ open: `0${n}:00`, close: `0${n}:30` })) }],
    ['a period with extra keys', { mon: [{ open: '09:00', close: '17:00', note: 'x' }] }],
    ['a period missing the close time', { mon: [{ open: '09:00' }] }],
    ['a period that is null', { mon: [null] }],
    ['a time without a leading zero', { mon: [{ open: '9:00', close: '17:00' }] }],
    ['a time past 23:59 as an opening time', { mon: [{ open: '24:00', close: '24:00' }] }],
    ['an hour that does not exist', { mon: [{ open: '09:00', close: '25:00' }] }],
    ['minutes that do not exist', { mon: [{ open: '09:60', close: '17:00' }] }],
    ['times that are not text', { mon: [{ open: 900, close: 1700 }] }],
    ['closing before opening', { mon: [{ open: '17:00', close: '09:00' }] }],
    ['opening and closing at the same time', { mon: [{ open: '09:00', close: '09:00' }] }],
    ['overlapping periods', { mon: [{ open: '08:00', close: '13:00' }, { open: '12:00', close: '17:00' }] }],
    ['periods that touch', { mon: [{ open: '08:00', close: '12:00' }, { open: '12:00', close: '17:00' }] }],
  ])('rejects %s, with a helpful message', (_label, hours) => {
    expect(validateBusinessHours(hours)).toEqual(expect.any(String));
  });
});

describe('normalizeBusinessHours', () => {
  it('fills in missing days and orders each day’s periods', () => {
    const hours = normalizeBusinessHours({ mon: [{ open: '13:00', close: '17:00' }, { open: '08:00', close: '12:00' }] });
    expect(hours.mon).toEqual([{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }]);
    expect(hours.tue).toEqual([]);
    expect(Object.keys(hours)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });

  it('keeps only the times (nothing extra sneaks through)', () => {
    const hours = normalizeBusinessHours({ mon: [{ open: '08:00', close: '12:00', note: 'x' }] });
    expect(hours.mon).toEqual([{ open: '08:00', close: '12:00' }]);
  });
});

describe('hasAnyOpeningHours', () => {
  it('is false for an empty week and true once any day has a period', () => {
    expect(hasAnyOpeningHours(emptyBusinessHours())).toBe(false);
    expect(hasAnyOpeningHours({ ...emptyBusinessHours(), sun: [{ open: '10:00', close: '11:00' }] })).toBe(true);
  });
});

describe('isOpenAt (on the practice’s own clock)', () => {
  const NY = 'America/New_York';
  const week = weekdays('09:00', '17:00'); // Monday to Friday

  it('opens at the opening minute and closes at the closing minute (the closing minute is closed)', () => {
    // 2026-09-28 is a Monday; New York is on daylight time (UTC-4).
    expect(isOpenAt(week, NY, new Date('2026-09-28T12:59:00Z'))).toBe(false); // 08:59
    expect(isOpenAt(week, NY, new Date('2026-09-28T13:00:00Z'))).toBe(true); // 09:00
    expect(isOpenAt(week, NY, new Date('2026-09-28T20:59:00Z'))).toBe(true); // 16:59
    expect(isOpenAt(week, NY, new Date('2026-09-28T21:00:00Z'))).toBe(false); // 17:00
  });

  it('is closed on days with no hours', () => {
    expect(isOpenAt(week, NY, new Date('2026-09-27T16:00:00Z'))).toBe(false); // Sunday noon
    expect(isOpenAt(week, NY, new Date('2026-10-03T16:00:00Z'))).toBe(false); // Saturday noon
  });

  it('uses the practice’s clock, not the server’s: the same instant can be different days', () => {
    // Sunday 23:30 UTC is Monday 04:30 in Karachi (UTC+5) but still Sunday in New York.
    const karachi = weekdays('04:00', '05:00');
    const instant = new Date('2026-09-27T23:30:00Z');
    expect(isOpenAt(karachi, 'Asia/Karachi', instant)).toBe(true);
    expect(isOpenAt(karachi, NY, instant)).toBe(false);
  });

  it('follows daylight saving time changes (a fixed offset would be wrong)', () => {
    const sundays: BusinessHours = { ...emptyBusinessHours(), sun: [{ open: '09:00', close: '17:00' }] };
    // Clocks in New York jump forward on Sunday 2026-03-08 at 02:00; after that it is UTC-4.
    expect(isOpenAt(sundays, NY, new Date('2026-03-08T12:59:00Z'))).toBe(false); // 08:59 EDT
    expect(isOpenAt(sundays, NY, new Date('2026-03-08T13:00:00Z'))).toBe(true); // 09:00 EDT
    // The week before, in winter time (UTC-5), 09:00 is 14:00 UTC.
    expect(isOpenAt(sundays, NY, new Date('2026-03-01T13:59:00Z'))).toBe(false); // 08:59 EST
    expect(isOpenAt(sundays, NY, new Date('2026-03-01T14:00:00Z'))).toBe(true); // 09:00 EST
  });

  it('handles a lunch break and a period that runs to midnight', () => {
    const hours: BusinessHours = { ...emptyBusinessHours(), fri: [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '24:00' }] };
    const at = (time: string) => isOpenAt(hours, 'UTC', new Date(`2026-10-02T${time}:00Z`)); // a Friday
    expect(at('11:59')).toBe(true);
    expect(at('12:30')).toBe(false);
    expect(at('13:00')).toBe(true);
    expect(at('23:59')).toBe(true);
    expect(isOpenAt(hours, 'UTC', new Date('2026-10-03T00:00:00Z'))).toBe(false); // Saturday, no hours
  });

  it('reads the local weekday and minutes correctly', () => {
    expect(localTime(new Date('2026-09-28T13:05:00Z'), 'America/New_York')).toEqual({ weekday: 'mon', minutes: 9 * 60 + 5 });
    expect(localTime(new Date('2026-09-28T00:00:00Z'), 'UTC')).toEqual({ weekday: 'mon', minutes: 0 }); // midnight is 00:00, never "24:00"
  });
});

describe('composeGreeting', () => {
  it('always adds the AI notice after the practice’s own words', () => {
    expect(composeGreeting('Thank you for calling Riverside Clinic.')).toBe(`Thank you for calling Riverside Clinic. ${AI_DISCLOSURE}`);
  });

  it('trims, and still says the notice when the greeting is empty', () => {
    expect(composeGreeting('  Hello.  ')).toBe(`Hello. ${AI_DISCLOSURE}`);
    expect(composeGreeting('')).toBe(AI_DISCLOSURE);
  });

  it('says plainly that it is an AI', () => {
    expect(AI_DISCLOSURE).toMatch(/AI assistant/);
    expect(AI_DISCLOSURE).toMatch(/not a person/);
  });
});

describe('aiReadinessProblems', () => {
  const TARGET = '0190a1b2-c3d4-7e5f-8a9b-000000000001';
  const ready: AiConfiguration = {
    greeting: 'Thank you for calling.',
    afterHoursAction: 'take_message',
    afterHoursTransferTargetId: null,
    emergencyMessage: 'If this is a medical emergency, hang up and call 911 now.',
    crisisMessage: 'If you are thinking about suicide, please call or text 988 now.',
    urgentAction: 'urgent_task',
    urgentTransferTargetId: null,
    businessHours: weekdays('09:00', '17:00'),
  };
  const active = [{ id: TARGET, active: true }];

  it('finds nothing wrong with a complete configuration', () => {
    expect(aiReadinessProblems(ready, [])).toEqual([]);
  });

  it.each([
    ['a missing greeting', { greeting: '   ' }, /greeting/],
    ['a missing emergency message', { emergencyMessage: '' }, /emergency message/],
    ['an emergency message that is only a few characters', { emergencyMessage: '911' }, /emergency message/],
    ['a missing crisis message', { crisisMessage: '' }, /crisis message/],
    ['a crisis message that is only a few characters', { crisisMessage: '988' }, /crisis message/],
    ['no business hours', { businessHours: emptyBusinessHours() }, /business hours/],
  ])('reports %s', (_label, change, message) => {
    const problems = aiReadinessProblems({ ...ready, ...change }, active);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
  });

  it.each(['transfer', 'transfer_and_task'] as const)('needs an active transfer number when urgent calls are %s', (urgentAction) => {
    expect(aiReadinessProblems({ ...ready, urgentAction }, active)).toHaveLength(1);
    expect(aiReadinessProblems({ ...ready, urgentAction, urgentTransferTargetId: TARGET }, active)).toEqual([]);
    expect(aiReadinessProblems({ ...ready, urgentAction, urgentTransferTargetId: TARGET }, [{ id: TARGET, active: false }])).toHaveLength(1); // an inactive number does not count
    expect(aiReadinessProblems({ ...ready, urgentAction, urgentTransferTargetId: TARGET }, [])).toHaveLength(1); // a number that does not exist
  });

  it('needs an active transfer number when after-hours calls are transferred', () => {
    const config = { ...ready, afterHoursAction: 'transfer' as const };
    expect(aiReadinessProblems(config, active)).toHaveLength(1);
    expect(aiReadinessProblems({ ...config, afterHoursTransferTargetId: TARGET }, active)).toEqual([]);
  });

  it('lists every problem at once', () => {
    const empty: AiConfiguration = { ...ready, greeting: '', emergencyMessage: '', crisisMessage: '', businessHours: emptyBusinessHours(), urgentAction: 'transfer', afterHoursAction: 'transfer' };
    expect(aiReadinessProblems(empty, [])).toHaveLength(6);
  });
});
