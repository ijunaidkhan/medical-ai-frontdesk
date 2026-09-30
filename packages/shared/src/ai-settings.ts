/**
 * How a practice configures its AI receptionist. The rules that keep it safe
 * (see aiReadinessProblems) live here so the API, the database and the web app
 * agree on them.
 */

// ------------------------------------------------------------- constants

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** What the AI does outside business hours. */
export const AFTER_HOURS_ACTIONS = ['take_message', 'transfer'] as const;
export type AfterHoursAction = (typeof AFTER_HOURS_ACTIONS)[number];

/** What happens for an URGENT (not emergency) request: hand over the call, alert staff, or both. */
export const URGENT_ACTIONS = ['transfer', 'urgent_task', 'transfer_and_task'] as const;
export type UrgentAction = (typeof URGENT_ACTIONS)[number];

export const TRANSFER_PURPOSES = ['front_desk', 'on_call', 'billing', 'other'] as const;
export type TransferPurpose = (typeof TRANSFER_PURPOSES)[number];

export const GREETING_MAX_LENGTH = 500;
export const EMERGENCY_MESSAGE_MIN_LENGTH = 10;
export const EMERGENCY_MESSAGE_MAX_LENGTH = 500;
export const URGENT_PHRASE_MIN_LENGTH = 2;
export const URGENT_PHRASE_MAX_LENGTH = 80;
export const URGENT_PHRASES_MAX_COUNT = 30;
export const TRANSFER_LABEL_MAX_LENGTH = 80;
export const MAX_INTERVALS_PER_DAY = 3;

/**
 * Said to every caller, before anything else. Fixed in code: a practice writes
 * its own greeting but cannot remove this notice.
 */
export const AI_DISCLOSURE = 'You are speaking with an automated AI assistant, not a person.';

export function composeGreeting(greeting: string): string {
  return `${greeting.trim()} ${AI_DISCLOSURE}`.trim();
}

// -------------------------------------------------------- business hours

/** Local clock times, 24-hour "HH:MM". `close` may be "24:00" (end of the day); open is always before close. */
export interface TimeInterval {
  open: string;
  close: string;
}

export type BusinessHours = Record<Weekday, TimeInterval[]>;

const OPEN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSE_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

export function emptyBusinessHours(): BusinessHours {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':') as [string, string];
  return Number(hours) * 60 + Number(minutes);
};

/**
 * Returns a message describing the first problem, or null when the hours are
 * usable. Days may be left out (meaning closed). Intervals within a day must
 * not overlap or touch, and a day may have at most three.
 */
export function validateBusinessHours(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Business hours must be an object with a list of opening times for each day';
  }
  for (const [day, intervals] of Object.entries(value)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) {
      return `"${day}" is not a day of the week (use ${WEEKDAYS.join(', ')})`;
    }
    if (!Array.isArray(intervals)) {
      return `Hours for ${day} must be a list`;
    }
    if (intervals.length > MAX_INTERVALS_PER_DAY) {
      return `At most ${MAX_INTERVALS_PER_DAY} opening periods per day (${day})`;
    }
    const parsed: Array<[number, number]> = [];
    for (const interval of intervals as unknown[]) {
      const { open, close, ...rest } = (interval ?? {}) as Record<string, unknown>;
      if (typeof open !== 'string' || typeof close !== 'string' || Object.keys(rest).length > 0) {
        return `Each opening period for ${day} needs just an "open" and a "close" time`;
      }
      if (!OPEN_TIME.test(open) || !CLOSE_TIME.test(close)) {
        return `Times for ${day} must look like 08:30 (24-hour); "24:00" is allowed only as a closing time`;
      }
      if (toMinutes(open) >= toMinutes(close)) {
        return `On ${day}, ${open} must be earlier than ${close}`;
      }
      parsed.push([toMinutes(open), toMinutes(close)]);
    }
    parsed.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i]![0] <= parsed[i - 1]![1]) {
        return `Opening periods on ${day} overlap or touch: merge them into one`;
      }
    }
  }
  return null;
}

/** Fills in missing days and orders each day's periods. Call only with hours that passed validation. */
export function normalizeBusinessHours(value: unknown): BusinessHours {
  const result = emptyBusinessHours();
  for (const day of WEEKDAYS) {
    const intervals = (value as Partial<BusinessHours>)[day] ?? [];
    result[day] = intervals.map(({ open, close }) => ({ open, close })).sort((a, b) => toMinutes(a.open) - toMinutes(b.open));
  }
  return result;
}

export function hasAnyOpeningHours(hours: BusinessHours): boolean {
  return WEEKDAYS.some((day) => hours[day].length > 0);
}

const WEEKDAY_BY_SHORT_NAME: Readonly<Record<string, Weekday>> = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };

/** The day of the week and minutes since midnight at `instant`, on the clock in `timeZone`. */
export function localTime(instant: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { weekday: WEEKDAY_BY_SHORT_NAME[get('weekday')] ?? 'mon', minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Is the practice open at this moment? A period includes its opening minute and excludes its closing minute. */
export function isOpenAt(hours: BusinessHours, timeZone: string, instant: Date): boolean {
  const { weekday, minutes } = localTime(instant, timeZone);
  return hours[weekday].some(({ open, close }) => minutes >= toMinutes(open) && minutes < toMinutes(close));
}

// ----------------------------------------------------- settings and targets

export interface TransferTarget {
  id: string;
  label: string;
  /** International format, e.g. +14155550123. */
  phone: string;
  purpose: TransferPurpose;
  active: boolean;
}

export interface CreateTransferTargetRequest {
  label: string;
  phone: string;
  purpose: TransferPurpose;
}

export interface UpdateTransferTargetRequest {
  label?: string;
  phone?: string;
  purpose?: TransferPurpose;
  active?: boolean;
}

export interface AiSettings {
  /** Whether the receptionist answers. It cannot be turned on until `ready` (see `problems`). */
  enabled: boolean;
  /** The practice's own welcome; the AI notice (AI_DISCLOSURE) is always added after it. */
  greeting: string;
  afterHoursAction: AfterHoursAction;
  afterHoursTransferTargetId: string | null;
  /** What callers hear in a medical emergency (who to call). Required, and worded for the practice's country. */
  emergencyMessage: string;
  urgentAction: UrgentAction;
  urgentTransferTargetId: string | null;
  /** Extra words or phrases that mark a call as urgent for this practice (added to the built-in list, never replacing it). */
  extraUrgentPhrases: string[];
  businessHours: BusinessHours;
  updatedAt: string | null;
  /** True when nothing stops the AI from being turned on. */
  ready: boolean;
  /** What still needs doing before the AI can be turned on. */
  problems: string[];
}

/** Only the fields present are changed. */
export interface UpdateAiSettingsRequest {
  enabled?: boolean;
  greeting?: string;
  afterHoursAction?: AfterHoursAction;
  afterHoursTransferTargetId?: string | null;
  emergencyMessage?: string;
  urgentAction?: UrgentAction;
  urgentTransferTargetId?: string | null;
  extraUrgentPhrases?: string[];
  businessHours?: BusinessHours;
}

export type AiConfiguration = Pick<
  AiSettings,
  | 'greeting'
  | 'afterHoursAction'
  | 'afterHoursTransferTargetId'
  | 'emergencyMessage'
  | 'urgentAction'
  | 'urgentTransferTargetId'
  | 'businessHours'
>;

/**
 * Everything that must be true before the receptionist may answer calls.
 * The two that matter most for safety, a greeting and an emergency message,
 * are also enforced by the database, so no bug can switch the AI on without them.
 */
export function aiReadinessProblems(config: AiConfiguration, targets: ReadonlyArray<Pick<TransferTarget, 'id' | 'active'>>): string[] {
  const problems: string[] = [];
  const activeTarget = (id: string | null) => id !== null && targets.some((target) => target.id === id && target.active);

  if (config.greeting.trim().length === 0) {
    problems.push('Write a greeting');
  }
  if (config.emergencyMessage.trim().length < EMERGENCY_MESSAGE_MIN_LENGTH) {
    problems.push('Write the emergency message callers will hear (who to call in a medical emergency)');
  }
  if (!hasAnyOpeningHours(config.businessHours)) {
    problems.push('Set your business hours');
  }
  if (config.urgentAction !== 'urgent_task' && !activeTarget(config.urgentTransferTargetId)) {
    problems.push('Choose an active transfer number for urgent calls, or set urgent calls to create a task only');
  }
  if (config.afterHoursAction === 'transfer' && !activeTarget(config.afterHoursTransferTargetId)) {
    problems.push('Choose an active transfer number for after-hours calls, or set after-hours calls to take a message');
  }
  return problems;
}
