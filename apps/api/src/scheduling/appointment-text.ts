import type { TimeFormat } from '@frontdesk/shared';

/**
 * The words the system writes about appointments. The AI receptionist never composes these: when a
 * booking, cancellation, move or list is a fact, the caller hears exactly what is built here from the
 * stored appointment, so a model can never state a wrong day, time or provider.
 */

export interface AppointmentFacts {
  typeName: string;
  providerName: string;
  startsAt: Date;
}

/** Said after a sentence the system wrote, to hand the conversation back to the caller. */
export const ANYTHING_ELSE = 'Is there anything else I can help you with?';

const weekdayDayMonth = (timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' });
const clock = (timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
const formatters = new Map<string, { date: Intl.DateTimeFormat; clock: Intl.DateTimeFormat }>();
const formattersFor = (timeZone: string) => {
  let found = formatters.get(timeZone);
  if (!found) {
    found = { date: weekdayDayMonth(timeZone), clock: clock(timeZone) };
    formatters.set(timeZone, found);
  }
  return found;
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** The hour (0 to 23) and minute on the practice's own clock. */
export function clockParts(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = formattersFor(timeZone).clock.formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // Some runtimes write midnight as 24 even with a 0 to 23 clock.
  return { hour: read('hour') % 24, minute: read('minute') };
}

/** "10:00 AM" or "14:30", on the practice's own clock. */
export function formatClock(at: Date, timeZone: string, format: TimeFormat): string {
  const { hour, minute } = clockParts(at, timeZone);
  if (format === '24h') return `${pad(hour)}:${pad(minute)}`;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** "Tuesday 7 October at 10:00 AM" (or "... at 14:30"), on the practice's own calendar and clock. */
export function formatWhen(at: Date, timeZone: string, format: TimeFormat): string {
  const parts = formattersFor(timeZone).date.formatToParts(at);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('weekday')} ${read('day')} ${read('month')} at ${formatClock(at, timeZone, format)}`;
}

/** Staff type these names; whatever they contain, a sentence stays on one line and short. */
export const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

const describe = (facts: AppointmentFacts, timeZone: string, format: TimeFormat) =>
  `${oneLine(facts.typeName)} with ${oneLine(facts.providerName)} on ${formatWhen(facts.startsAt, timeZone, format)}`;

export function bookedSentence(facts: AppointmentFacts, timeZone: string, format: TimeFormat): string {
  return `Your ${oneLine(facts.typeName)} with ${oneLine(facts.providerName)} is booked for ${formatWhen(facts.startsAt, timeZone, format)}.`;
}

export function cancelledSentence(facts: AppointmentFacts, timeZone: string, format: TimeFormat): string {
  return `Your ${describe(facts, timeZone, format)} has been cancelled.`;
}

export function movedSentence(facts: AppointmentFacts, timeZone: string, format: TimeFormat): string {
  return `Your ${oneLine(facts.typeName)} has been moved to ${formatWhen(facts.startsAt, timeZone, format)} with ${oneLine(facts.providerName)}.`;
}

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];

export function listSentence(appointments: readonly AppointmentFacts[], timeZone: string, format: TimeFormat): string {
  if (appointments.length === 0) {
    return 'I do not see any upcoming appointments for you.';
  }
  if (appointments.length === 1) {
    return `You have one upcoming appointment: ${describe(appointments[0]!, timeZone, format)}.`;
  }
  const items = appointments.map((appointment, index) => `${ORDINALS[index] ?? `Number ${index + 1}`}, ${describe(appointment, timeZone, format)}.`);
  return `You have ${appointments.length} upcoming appointments. ${items.join(' ')}`;
}
