import { emptyBusinessHours, type BusinessHours } from '@frontdesk/shared';
import { computeSlots, computeSlotsForProviders, isSlotOffered, type Interval, type ProviderSchedule, type SlotQuery } from './availability.js';

// Reference week: Monday 5 October 2026. "now" is the Sunday before, at noon UTC.
const NOW = new Date('2026-10-04T12:00:00Z');
const at = (isoTime: string) => new Date(isoTime);
const span = (from: string, to: string): Interval => ({ startsAt: at(from), endsAt: at(to) });
const starts = (slots: Array<{ startsAt: Date }>) => slots.map((slot) => slot.startsAt.toISOString().slice(11, 16));

const weekdays = (...periods: Array<[string, string]>): BusinessHours => {
  const hours = emptyBusinessHours();
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) hours[day] = periods.map(([open, close]) => ({ open, close }));
  return hours;
};

const provider = (hours: BusinessHours, extra: Partial<ProviderSchedule> = {}): ProviderSchedule => ({ id: 'p1', hours, timeOff: [], busy: [], ...extra });

const query = (extra: Partial<SlotQuery> = {}): SlotQuery => ({
  timeZone: 'UTC',
  rules: { slotMinutes: 30, minNoticeHours: 2, maxAdvanceDays: 60 },
  durationMinutes: 30,
  from: at('2026-10-05T00:00:00Z'),
  to: at('2026-10-06T00:00:00Z'), // Monday only
  now: NOW,
  limit: 100,
  ...extra,
});

describe('computeSlots', () => {
  const morning = provider(weekdays(['09:00', '12:00']));

  describe('the basics', () => {
    it('offers every slot on the grid inside the working period, and none that would run past closing', () => {
      expect(starts(computeSlots(morning, query()))).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    });

    it('a longer visit leaves fewer start times: the last one must still finish by closing', () => {
      const slots = computeSlots(morning, query({ durationMinutes: 45, rules: { slotMinutes: 15, minNoticeHours: 2, maxAdvanceDays: 60 } }));
      expect(starts(slots)).toEqual(['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15']);
      expect(slots.at(-1)!.endsAt.toISOString().slice(11, 16)).toBe('12:00');
    });

    it('a visit longer than the working period is never offered', () => {
      expect(computeSlots(morning, query({ durationMinutes: 240 }))).toEqual([]);
    });

    it('a visit that exactly fills the period is offered once', () => {
      expect(starts(computeSlots(morning, query({ durationMinutes: 180 })))).toEqual(['09:00']);
    });

    it('each slot says which provider, when it starts and when it ends', () => {
      const [first] = computeSlots(morning, query());
      expect(first).toEqual({ providerId: 'p1', startsAt: at('2026-10-05T09:00:00Z'), endsAt: at('2026-10-05T09:30:00Z') });
    });

    it('closed days and a provider with no hours offer nothing', () => {
      expect(computeSlots(morning, query({ from: at('2026-10-03T00:00:00Z'), to: at('2026-10-05T00:00:00Z'), now: at('2026-10-01T00:00:00Z') }))).toEqual([]); // Saturday and Sunday
      expect(computeSlots(provider(emptyBusinessHours()), query())).toEqual([]);
    });

    it('stops at the limit, keeping the earliest', () => {
      expect(starts(computeSlots(morning, query({ limit: 2 })))).toEqual(['09:00', '09:30']);
    });

    it.each([
      ['a limit of zero', { limit: 0 }],
      ['a visit of no length', { durationMinutes: 0 }],
      ['slots of no length', { rules: { slotMinutes: 0, minNoticeHours: 2, maxAdvanceDays: 60 } }],
      ['a window that ends before it starts', { from: at('2026-10-06T00:00:00Z'), to: at('2026-10-05T00:00:00Z') }],
      ['an empty window', { from: at('2026-10-05T10:00:00Z'), to: at('2026-10-05T10:00:00Z') }],
    ])('offers nothing for %s', (_name, change) => {
      expect(computeSlots(morning, query(change))).toEqual([]);
    });

    it('is the same every time it is asked', () => {
      expect(computeSlots(morning, query())).toEqual(computeSlots(morning, query()));
    });
  });

  describe('days, periods and the grid', () => {
    it('walks several days and offers the earliest first', () => {
      const slots = computeSlots(morning, query({ to: at('2026-10-08T00:00:00Z'), limit: 8 }));
      expect(slots.map((slot) => slot.startsAt.toISOString().slice(0, 16))).toEqual([
        '2026-10-05T09:00', '2026-10-05T09:30', '2026-10-05T10:00', '2026-10-05T10:30', '2026-10-05T11:00', '2026-10-05T11:30',
        '2026-10-06T09:00', '2026-10-06T09:30',
      ]);
    });

    it('a split day (morning and afternoon) offers both, and nothing over lunch', () => {
      const split = provider(weekdays(['09:00', '12:00'], ['13:00', '15:00']));
      expect(starts(computeSlots(split, query({ durationMinutes: 60, rules: { slotMinutes: 60, minNoticeHours: 2, maxAdvanceDays: 60 } })))).toEqual(['09:00', '10:00', '11:00', '13:00', '14:00']);
    });

    it('the grid is counted from the start of each working period, not from midnight', () => {
      const odd = provider(weekdays(['09:10', '11:00']));
      expect(starts(computeSlots(odd, query()))).toEqual(['09:10', '09:40', '10:10']); // 10:40 + 30 would run past 11:00
    });

    it('a period that runs to midnight ("24:00") offers its last slot', () => {
      const evening = provider(weekdays(['22:00', '24:00']));
      expect(starts(computeSlots(evening, query()))).toEqual(['22:00', '22:30', '23:00', '23:30']);
    });

    it('different weekdays can have different hours', () => {
      const hours = emptyBusinessHours();
      hours.mon = [{ open: '09:00', close: '10:00' }];
      hours.tue = [{ open: '14:00', close: '15:00' }];
      const slots = computeSlots(provider(hours), query({ to: at('2026-10-07T00:00:00Z') }));
      expect(slots.map((slot) => slot.startsAt.toISOString().slice(0, 16))).toEqual(['2026-10-05T09:00', '2026-10-05T09:30', '2026-10-06T14:00', '2026-10-06T14:30']);
    });
  });

  describe('the practice’s rules', () => {
    it('minimum notice: nothing sooner than that many hours from now', () => {
      const slots = computeSlots(morning, query({ now: at('2026-10-05T08:00:00Z') })); // 2 hours' notice -> from 10:00
      expect(starts(slots)).toEqual(['10:00', '10:30', '11:00', '11:30']);
    });

    it('a slot exactly at the notice limit is allowed; one minute earlier is not', () => {
      expect(starts(computeSlots(morning, query({ now: at('2026-10-05T08:00:00Z') })))[0]).toBe('10:00');
      expect(starts(computeSlots(morning, query({ now: at('2026-10-05T08:01:00Z') })))[0]).toBe('10:30');
    });

    it('no notice at all: anything still ahead of now', () => {
      const slots = computeSlots(morning, query({ now: at('2026-10-05T10:10:00Z'), rules: { slotMinutes: 30, minNoticeHours: 0, maxAdvanceDays: 60 } }));
      expect(starts(slots)).toEqual(['10:30', '11:00', '11:30']);
    });

    it('after closing time, today offers nothing and the next day is offered', () => {
      const slots = computeSlots(morning, query({ now: at('2026-10-05T13:00:00Z'), to: at('2026-10-07T00:00:00Z'), limit: 2 }));
      expect(slots.map((slot) => slot.startsAt.toISOString().slice(0, 16))).toEqual(['2026-10-06T09:00', '2026-10-06T09:30']);
    });

    it('furthest ahead: nothing beyond that many days from now', () => {
      const slots = computeSlots(morning, query({ to: at('2026-12-31T00:00:00Z'), rules: { slotMinutes: 30, minNoticeHours: 2, maxAdvanceDays: 3 }, limit: 1000 }));
      // now = Sunday 4 Oct 12:00; three days on is Wednesday 7 Oct 12:00: Monday, Tuesday and Wednesday morning are open.
      expect(new Set(slots.map((slot) => slot.startsAt.toISOString().slice(0, 10)))).toEqual(new Set(['2026-10-05', '2026-10-06', '2026-10-07']));
    });

    it('the search window is respected on both ends, with the end not included', () => {
      const slots = computeSlots(morning, query({ from: at('2026-10-05T10:00:00Z'), to: at('2026-10-05T11:00:00Z') }));
      expect(starts(slots)).toEqual(['10:00', '10:30']);
    });
  });

  describe('time off and existing appointments', () => {
    it('a slot that overlaps time off is not offered; ones that only touch it are', () => {
      const off = provider(weekdays(['09:00', '12:00']), { timeOff: [span('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z')] });
      expect(starts(computeSlots(off, query()))).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
    });

    it('a booked appointment blocks every slot it overlaps', () => {
      const busy = provider(weekdays(['09:00', '12:00']), { busy: [span('2026-10-05T09:30:00Z', '2026-10-05T10:30:00Z')] });
      expect(starts(computeSlots(busy, query()))).toEqual(['09:00', '10:30', '11:00', '11:30']);
    });

    it('a long visit is blocked by an appointment anywhere inside it', () => {
      const busy = provider(weekdays(['09:00', '12:00']), { busy: [span('2026-10-05T10:15:00Z', '2026-10-05T10:20:00Z')] });
      const slots = computeSlots(busy, query({ durationMinutes: 60, rules: { slotMinutes: 30, minNoticeHours: 2, maxAdvanceDays: 60 } }));
      // 09:30 (to 10:30) and 10:00 (to 11:00) run through 10:15-10:20; 09:00 finishes before it and 10:30 starts after it.
      expect(starts(slots)).toEqual(['09:00', '10:30', '11:00']);
    });

    it('a whole day off removes the whole day, and the next day is unaffected', () => {
      const holiday = provider(weekdays(['09:00', '12:00']), { timeOff: [span('2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z')] });
      const slots = computeSlots(holiday, query({ to: at('2026-10-07T00:00:00Z'), limit: 1 }));
      expect(slots[0]!.startsAt.toISOString()).toBe('2026-10-06T09:00:00.000Z');
    });

    it('several blocks together', () => {
      const busy = provider(weekdays(['09:00', '12:00']), {
        timeOff: [span('2026-10-05T09:00:00Z', '2026-10-05T09:30:00Z')],
        busy: [span('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'), span('2026-10-05T11:00:00Z', '2026-10-05T12:00:00Z')],
      });
      expect(starts(computeSlots(busy, query()))).toEqual(['09:30', '10:30']);
    });
  });

  describe('the practice’s own clock (time zones and daylight saving)', () => {
    it('hours are read on the practice’s clock: 09:00 in Karachi is 04:00 UTC', () => {
      const karachi = query({ timeZone: 'Asia/Karachi', from: at('2026-10-04T20:00:00Z'), to: at('2026-10-05T20:00:00Z') });
      const slots = computeSlots(provider(weekdays(['09:00', '11:00'])), karachi);
      expect(slots.map((slot) => slot.startsAt.toISOString().slice(0, 16))).toEqual(['2026-10-05T04:00', '2026-10-05T04:30', '2026-10-05T05:00', '2026-10-05T05:30']);
    });

    it('the same hours fall at a different UTC time in summer and winter (New York)', () => {
      const ny = (from: string, to: string, now: string) => computeSlots(provider(weekdays(['09:00', '09:30'])), query({ timeZone: 'America/New_York', from: at(from), to: at(to), now: at(now), limit: 1 }));
      expect(ny('2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', '2026-10-01T00:00:00Z')[0]!.startsAt.toISOString()).toBe('2026-10-05T13:00:00.000Z'); // EDT
      expect(ny('2026-12-07T00:00:00Z', '2026-12-08T00:00:00Z', '2026-12-01T00:00:00Z')[0]!.startsAt.toISOString()).toBe('2026-12-07T14:00:00.000Z'); // EST
    });

    it('the day is the practice’s day: 23:00 Sunday UTC is already Monday morning in Auckland', () => {
      const auckland = query({ timeZone: 'Pacific/Auckland', from: at('2026-10-04T00:00:00Z'), to: at('2026-10-06T00:00:00Z'), now: at('2026-10-03T00:00:00Z') });
      const slots = computeSlots(provider(weekdays(['09:00', '09:30'])), auckland);
      expect(slots[0]!.startsAt.toISOString()).toBe('2026-10-04T20:00:00.000Z'); // 09:00 on Monday 5 Oct at UTC+13
    });

    it('when the clocks jump forward (New York, Sunday 8 March 2026) the hour that never happens is skipped', () => {
      const hours = emptyBusinessHours();
      hours.sun = [{ open: '01:00', close: '05:00' }];
      const slots = computeSlots(
        provider(hours),
        query({ timeZone: 'America/New_York', durationMinutes: 60, rules: { slotMinutes: 60, minNoticeHours: 0, maxAdvanceDays: 60 }, from: at('2026-03-08T00:00:00Z'), to: at('2026-03-09T00:00:00Z'), now: at('2026-03-01T00:00:00Z') }),
      );
      expect(slots.map((slot) => slot.startsAt.toISOString().slice(11, 16))).toEqual(['06:00', '07:00', '08:00']); // 1:00 EST, 3:00 EDT, 4:00 EDT: no 2:00
    });

    it('when the clocks go back (New York, Sunday 1 November 2026) the repeated hour is offered once, not twice', () => {
      const hours = emptyBusinessHours();
      hours.sun = [{ open: '00:00', close: '03:00' }];
      const slots = computeSlots(
        provider(hours),
        query({ timeZone: 'America/New_York', durationMinutes: 60, rules: { slotMinutes: 60, minNoticeHours: 0, maxAdvanceDays: 60 }, from: at('2026-11-01T00:00:00Z'), to: at('2026-11-02T00:00:00Z'), now: at('2026-10-25T00:00:00Z') }),
      );
      expect(slots.map((slot) => slot.startsAt.toISOString().slice(11, 16))).toEqual(['04:00', '05:00', '07:00']); // 0:00, 1:00 (first), 2:00; never two 1:00s
    });
  });

  describe('safety limits', () => {
    it('never walks more than a bounded number of days, however large a window is asked for', () => {
      const started = Date.now();
      const slots = computeSlots(provider(emptyBusinessHours()), query({ from: at('2026-10-05T00:00:00Z'), to: at('2100-01-01T00:00:00Z'), rules: { slotMinutes: 5, minNoticeHours: 0, maxAdvanceDays: 365 } }));
      expect(slots).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('a busy two-month search for two providers is fast', () => {
      const started = Date.now();
      const all = computeSlotsForProviders([morning, provider(weekdays(['08:00', '18:00']), { id: 'p2' })], query({ to: at('2026-12-05T00:00:00Z'), rules: { slotMinutes: 5, minNoticeHours: 0, maxAdvanceDays: 365 }, limit: 100_000 }));
      expect(all.length).toBeGreaterThan(5_000);
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });
});

describe('computeSlotsForProviders', () => {
  const one = provider(weekdays(['09:00', '10:00']), { id: 'one' });
  const two = provider(weekdays(['09:30', '10:30']), { id: 'two' });

  it('merges the offers, earliest first, with ties in the providers’ order', () => {
    const merged = computeSlotsForProviders([one, two], query());
    expect(merged.map((slot) => `${slot.startsAt.toISOString().slice(11, 16)} ${slot.providerId}`)).toEqual(['09:00 one', '09:30 one', '09:30 two', '10:00 two']);
  });

  it('stops at the limit overall, not per provider', () => {
    expect(computeSlotsForProviders([one, two], query({ limit: 3 }))).toHaveLength(3);
  });

  it('one provider’s time off does not affect another', () => {
    const off = provider(weekdays(['09:00', '10:00']), { id: 'off', timeOff: [span('2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z')] });
    expect(computeSlotsForProviders([off, two], query()).every((slot) => slot.providerId === 'two')).toBe(true);
  });

  it('nobody is offered when there are no providers', () => {
    expect(computeSlotsForProviders([], query())).toEqual([]);
  });
});

describe('isSlotOffered (checked again at the moment of booking)', () => {
  const { from: _from, to: _to, limit: _limit, ...rest } = query();
  const base = provider(weekdays(['09:00', '12:00']));

  it('yes for a time on the grid that is free', () => {
    expect(isSlotOffered(base, rest, at('2026-10-05T10:00:00Z'))).toBe(true);
  });

  it.each([
    ['a time not on the grid', '2026-10-05T10:07:00Z'],
    ['a time before opening', '2026-10-05T08:30:00Z'],
    ['a visit that would run past closing', '2026-10-05T11:45:00Z'],
    ['a closed day', '2026-10-04T10:00:00Z'],
    ['a time too soon (inside the notice period)', '2026-10-04T13:00:00Z'],
  ])('no for %s', (_name, time) => {
    expect(isSlotOffered(base, rest, at(time))).toBe(false);
  });

  it('no once it has been taken, or falls inside time off', () => {
    expect(isSlotOffered(provider(weekdays(['09:00', '12:00']), { busy: [span('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z')] }), rest, at('2026-10-05T10:00:00Z'))).toBe(false);
    expect(isSlotOffered(provider(weekdays(['09:00', '12:00']), { timeOff: [span('2026-10-05T09:45:00Z', '2026-10-05T10:15:00Z')] }), rest, at('2026-10-05T10:00:00Z'))).toBe(false);
  });
});
