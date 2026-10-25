import type { AvailabilitySlot } from '@frontdesk/shared';
import type { Transaction } from 'kysely';
import type { RequestMeta } from '../../common/request-meta.js';
import type { Database } from '../../database/database.types.js';
import type { CreatePatientDto } from '../appointments.dto.js';
import type { AppointmentFacts } from '../appointment-text.js';

/**
 * Where the AI receptionist's scheduling tools read and change a practice's calendar. Today that is always our own
 * tables (`NativeAdapter`); a practice on an EHR will get an adapter for it (see docs/architecture/ehr-integration.md).
 *
 * The rules that do not depend on where the calendar lives stay in the tools: identity checks and their limits, the
 * codes the model sees, the backend-written sentences, and turning a refusal into words. An adapter applies the
 * calendar's own rules (open times, double booking, the cancellation window) and throws the same exceptions the
 * native services do: `ConflictException` when a time is taken, `CancellationWindowError` inside the window,
 * `NotFoundException` / `BadRequestException` when the change cannot be made.
 *
 * Everything here acts for a caller through the AI receptionist. Staff screens keep using the services directly.
 */
export interface SchedulingGateway {
  /** The visit types a caller can book. */
  listVisitTypes(scope: GatewayScope): Promise<VisitType[]>;
  /** Open start times for one visit type in [from, to), earliest first, under the practice's rules for callers. */
  findSlots(scope: GatewayScope, query: SlotSearch): Promise<AvailabilitySlot[]>;
  /** The one patient who matches, or null (also when two match: never a guess). */
  findPatient(scope: GatewayScope, query: PatientQuery): Promise<PatientRef | null>;
  /** A patient's upcoming booked appointments, soonest first. */
  listAppointments(scope: GatewayScope, patientId: string, limit: number): Promise<AppointmentRecord[]>;
  /** One appointment, or null when it does not exist. */
  getAppointment(scope: GatewayScope, appointmentId: string): Promise<AppointmentRecord | null>;
  /** Books a time; the same idempotency key books once. A new patient is added first when the calendar allows it. */
  book(scope: GatewayScope, request: BookRequest): Promise<AppointmentRecord>;
  cancel(scope: GatewayScope, appointmentId: string, reason: string): Promise<void>;
  /** Moves an appointment to a new time (and maybe provider); the same idempotency key moves once. */
  reschedule(scope: GatewayScope, appointmentId: string, request: MoveRequest): Promise<AppointmentRecord>;
}

/**
 * The practice and the transaction a tool runs in. The native adapter works inside this transaction, so a booking,
 * its audit entry and the tool's own record commit or roll back together. An adapter that calls an outside system
 * does not use `trx` for that call.
 */
export interface GatewayScope {
  trx: Transaction<Database>;
  practiceId: string;
  meta: RequestMeta;
}

export interface VisitType {
  id: string;
  name: string;
  durationMinutes: number;
}

export interface SlotSearch {
  appointmentTypeId: string;
  from: Date;
  to: Date;
  limit: number;
  now: Date;
}

/** Name and date of birth (the full name as one text), or all four details for the stricter check. */
export type PatientQuery = { fullName: string; dateOfBirth: string } | Pick<CreatePatientDto, 'firstName' | 'lastName' | 'dateOfBirth' | 'phone'>;

export interface PatientRef {
  id: string;
  /** The number on file, for calling the patient back. Never shown to the model. */
  phone: string;
}

export interface AppointmentRecord {
  id: string;
  patientId: string;
  appointmentTypeId: string;
  /** What the backend's sentences say about it. */
  facts: AppointmentFacts;
}

export interface BookRequest {
  /** A known patient, or the details of someone new. */
  patient: { id: string } | { create: CreatePatientDto };
  providerId: string;
  appointmentTypeId: string;
  startsAt: Date;
  idempotencyKey: string;
  /** The conversation that made the booking, kept with it for review. */
  conversationId: string | null;
}

export interface MoveRequest {
  providerId: string;
  startsAt: Date;
  idempotencyKey: string;
  conversationId: string | null;
}
