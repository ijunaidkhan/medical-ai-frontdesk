import type { BusinessHours } from '@frontdesk/shared';
import { addDays, localDate, weekdayOf, wallClockMs, wallClockOf, zonedInstant } from './zoned-time.js';

/** A stretch of real time: starts at `startsAt`, ends (not included) at `endsAt`. */
export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

/** Everything the engine needs to know about one provider. Plain data: no database in here. */
export interface ProviderSchedule {
  id: string;
  /** Weekly working hours in the practice's time zone. */
  hours: BusinessHours;
  /** Holidays, leave: the provider cannot be booked in these. */
  timeOff: readonly Interval[];
  /** Appointments already booked for this provider. */
  busy: readonly Interval[];
}

export interface SlotRules {
  /** Start times are offered every this many minutes, counted from the start of each working period. */
  slotMinutes: number;
  /** Nothing earlier than this many hours from `now`. */
  minNoticeHours: number;
  /** Nothing later than this many days from `now`. */
  maxAdvanceDays: number;
}

export interface SlotQuery {
  /** The practice's time zone: the hours are read on its clock. */
  timeZone: string;
  rules: SlotRules;
  durationMinutes: number;
  /** Only start times from here (inclusive)... */
  from: Date;
  /** ...to here (not included). */
  to: Date;
  now: Date;
  /** Stop after this many slots. */
  limit: number;
}

export interface ComputedSlot {
  providerId: string;
  startsAt: Date;
  endsAt: Date;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** However large a window is asked for, never walk further than this many calendar days. */
const MAX_DAYS_WALKED = 400;

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

const overlaps = (a: Interval, b: Interval): boolean => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/**
 * The start times at which one provider can be booked for a visit of
 * `durationMinutes`: inside their working hours (read on the practice's clock, daylight
 * saving included), outside their time off and existing appointments, after the minimum
 * notice and before the furthest-ahead limit. Earliest first.
 *
 * Pure: the same input always gives the same answer, which is what makes it testable.
 * The database separately guarantees that two appointments can never overlap; this is
 * how the offers are worked out, never the last line of defence.
 */
export function computeSlots(provider: ProviderSchedule, query: SlotQuery): ComputedSlot[] {
  const { timeZone, rules, durationMinutes, now, limit } = query;
  const earliest = Math.max(query.from.getTime(), now.getTime() + rules.minNoticeHours * HOUR);
  // A start time is allowed up to the end of the furthest-ahead day, and before `to`.
  const latest = Math.min(query.to.getTime() - 1, now.getTime() + rules.maxAdvanceDays * DAY);
  if (limit <= 0 || durationMinutes <= 0 || rules.slotMinutes <= 0 || earliest > latest) return [];

  const blocked: Interval[] = [...provider.timeOff, ...provider.busy];
  const slots: ComputedSlot[] = [];
  const first = localDate(new Date(earliest), timeZone);
  const last = localDate(new Date(latest), timeZone);

  for (let offset = 0; offset < MAX_DAYS_WALKED; offset += 1) {
    const date = addDays(first, offset);
    if (wallClockOf(date, 0) > wallClockOf(last, 0)) break;

    for (const { open, close } of provider.hours[weekdayOf(date)]) {
      const closeMinutes = toMinutes(close);
      const closeWall = wallClockOf(date, closeMinutes);
      for (let minutes = toMinutes(open); minutes + durationMinutes <= closeMinutes; minutes += rules.slotMinutes) {
        const startsAt = zonedInstant(date, minutes, timeZone);
        if (startsAt === null) continue; // that time does not exist today (the clocks jumped forward)
        const start = startsAt.getTime();
        if (start < earliest) continue;
        if (start > latest) return slots;
        const endsAt = new Date(start + durationMinutes * MINUTE);
        // The visit must also finish by closing time on the clock (a day with a clock change is shorter or longer).
        if (wallClockMs(endsAt, timeZone) > closeWall) continue;
        const candidate = { startsAt, endsAt };
        if (blocked.some((interval) => overlaps(candidate, interval))) continue;
        slots.push({ providerId: provider.id, startsAt, endsAt });
        if (slots.length >= limit) return slots;
      }
    }
  }
  return slots;
}

/** The earliest offers across several providers, earliest first (ties keep the providers' order). */
export function computeSlotsForProviders(providers: readonly ProviderSchedule[], query: SlotQuery): ComputedSlot[] {
  const merged = providers.flatMap((provider, index) => computeSlots(provider, query).map((slot) => ({ slot, index })));
  merged.sort((a, b) => a.slot.startsAt.getTime() - b.slot.startsAt.getTime() || a.index - b.index);
  return merged.slice(0, query.limit).map(({ slot }) => slot);
}

/**
 * Is this exact start time one that would be offered right now? Used when a booking is
 * made, so that what was offered a moment ago is checked again at the moment it is taken.
 */
export function isSlotOffered(provider: ProviderSchedule, query: Omit<SlotQuery, 'from' | 'to' | 'limit'>, startsAt: Date): boolean {
  const slots = computeSlots(provider, { ...query, from: startsAt, to: new Date(startsAt.getTime() + 1), limit: 1 });
  return slots.length === 1 && slots[0]!.startsAt.getTime() === startsAt.getTime();
}

