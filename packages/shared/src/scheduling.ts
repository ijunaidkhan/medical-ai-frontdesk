import type { BusinessHours } from './ai-settings.js';

/**
 * Scheduling: who can be booked (providers), for what (appointment types), when
 * (their hours and days off), and the practice's booking rules. Appointments and
 * patients come in the next step of the scheduling plan.
 */

/** Start times are offered on this grid, counted from the start of each working period. */
export const SLOT_MINUTES_OPTIONS = [5, 10, 15, 20, 30, 60] as const;
export type SlotMinutes = (typeof SLOT_MINUTES_OPTIONS)[number];

export const APPOINTMENT_DURATION_MIN = 5;
export const APPOINTMENT_DURATION_MAX = 480;
export const PROVIDER_NAME_MAX_LENGTH = 120;
export const PROVIDER_TITLE_MAX_LENGTH = 120;
export const APPOINTMENT_TYPE_NAME_MAX_LENGTH = 120;
export const TIME_OFF_REASON_MAX_LENGTH = 200;
export const MAX_PROVIDERS = 200;
export const MAX_APPOINTMENT_TYPES = 200;

export const MIN_NOTICE_HOURS_MAX = 720;
export const MAX_ADVANCE_DAYS_MAX = 365;
export const CANCEL_MIN_HOURS_MAX = 720;

/** The practice's booking rules. */
export interface SchedulingSettings {
  slotMinutes: SlotMinutes;
  /** The earliest a visit can be booked: this many hours from now. */
  minNoticeHours: number;
  /** The furthest ahead a visit can be booked. */
  maxAdvanceDays: number;
  /** The AI will not cancel or move a visit closer than this many hours; it takes a message for staff instead. */
  cancelMinHours: number;
  /** Whether the AI receptionist may book, cancel and move appointments at all. Off until a person turns it on. */
  aiBookingEnabled: boolean;
  updatedAt: string | null;
}

export const SCHEDULING_DEFAULTS: Omit<SchedulingSettings, 'updatedAt'> = {
  slotMinutes: 15,
  minNoticeHours: 2,
  maxAdvanceDays: 60,
  cancelMinHours: 24,
  aiBookingEnabled: false,
};

export type UpdateSchedulingSettingsRequest = Partial<Omit<SchedulingSettings, 'updatedAt'>>;

export interface Provider {
  id: string;
  name: string;
  /** For example "Dr", "Nurse practitioner" or "Room 2"; shown next to the name. */
  title: string;
  /** Weekly working hours, in the practice's time zone. */
  hours: BusinessHours;
  active: boolean;
  /** The appointment types this provider offers. */
  appointmentTypeIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderRequest {
  name: string;
  title?: string;
  hours?: BusinessHours;
  appointmentTypeIds?: string[];
}

/** Only the fields present are changed. `appointmentTypeIds` replaces the whole list. */
export interface UpdateProviderRequest {
  name?: string;
  title?: string;
  hours?: BusinessHours;
  active?: boolean;
  appointmentTypeIds?: string[];
}

export interface AppointmentType {
  id: string;
  name: string;
  durationMinutes: number;
  active: boolean;
  /** The providers who offer it. */
  providerIds: string[];
}

export interface CreateAppointmentTypeRequest {
  name: string;
  durationMinutes: number;
  providerIds?: string[];
}

export interface UpdateAppointmentTypeRequest {
  name?: string;
  durationMinutes?: number;
  active?: boolean;
  providerIds?: string[];
}

/** A stretch when a provider cannot be booked (holiday, leave, a meeting). It is cancelled, never deleted. */
export interface ProviderTimeOff {
  id: string;
  providerId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  active: boolean;
}

export interface CreateTimeOffRequest {
  startsAt: string;
  endsAt: string;
  reason?: string;
}

export const AVAILABILITY_LIMIT_DEFAULT = 20;
export const AVAILABILITY_LIMIT_MAX = 100;
/** The longest stretch one availability search may cover. */
export const AVAILABILITY_WINDOW_MAX_DAYS = 62;

/** One bookable start time. */
export interface AvailabilitySlot {
  providerId: string;
  providerName: string;
  appointmentTypeId: string;
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityResponse {
  /** The practice's time zone: slot times are instants, shown in this zone. */
  timezone: string;
  slots: AvailabilitySlot[];
}

// ------------------------------------------------------- patients and appointments

export const PATIENT_NAME_MAX_LENGTH = 100;
export const PATIENT_SEARCH_LIMIT_DEFAULT = 10;
export const PATIENT_SEARCH_LIMIT_MAX = 25;
/** A search needs at least this many characters, so it can never list the whole patient book. */
export const PATIENT_SEARCH_MIN_LENGTH = 2;

/** Only what scheduling needs: no clinical information. */
export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
  /** International format, for example +14155550123. */
  phone: string;
  createdAt: string;
}

export interface CreatePatientRequest {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phone: string;
}

/**
 * A real calendar date in YYYY-MM-DD form, from 1900 up to tomorrow (a birth date cannot be in the future;
 * one day of slack covers the practice being ahead of UTC).
 */
export function isValidBirthDate(value: string, now: Date = new Date()): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  return date.getTime() <= now.getTime() + 86_400_000;
}

export const APPOINTMENT_STATUSES = ['booked', 'cancelled', 'completed', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const APPOINTMENT_CANCEL_REASON_MAX_LENGTH = 200;
/** The most that one list of appointments covers. */
export const APPOINTMENT_WINDOW_MAX_DAYS = 62;
export const APPOINTMENT_LIST_DEFAULT_DAYS = 7;
export const APPOINTMENT_LIST_LIMIT_DEFAULT = 200;
export const APPOINTMENT_LIST_LIMIT_MAX = 500;
/** Every booking carries one of these so that a retried request books once. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export interface Appointment {
  id: string;
  patient: { id: string; firstName: string; lastName: string };
  providerId: string;
  providerName: string;
  appointmentTypeId: string;
  appointmentTypeName: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  /** Who made the booking: a member of staff or the AI receptionist. */
  bookedBy: 'user' | 'ai';
  cancelledAt: string | null;
  cancelReason: string;
  /** Set when this appointment replaced another one that was moved. */
  rescheduledFromId: string | null;
}

export interface BookAppointmentRequest {
  patientId: string;
  providerId: string;
  appointmentTypeId: string;
  startsAt: string;
}

export interface RescheduleAppointmentRequest {
  startsAt: string;
  /** Another provider who offers the same visit; the same provider when left out. */
  providerId?: string;
}

export interface CancelAppointmentRequest {
  reason?: string;
}
