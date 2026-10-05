import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  APPOINTMENT_LIST_DEFAULT_DAYS,
  APPOINTMENT_LIST_LIMIT_DEFAULT,
  APPOINTMENT_WINDOW_MAX_DAYS,
  MAX_ADVANCE_DAYS_MAX,
  normalizeBusinessHours,
  type Appointment,
  type AppointmentStatus,
} from '@frontdesk/shared';
import { sql, type Transaction } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { auditActor, type SchedulingActor } from './actor.js';
import type { AppointmentListQuery } from './appointments.dto.js';
import { isSlotOffered, type Interval } from './availability.js';
import { loadBusy } from './busy.js';
import { SchedulingService } from './scheduling.service.js';

type Trx = Transaction<Database>;

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const EXCLUSION_VIOLATION = '23P01';
const UNIQUE_VIOLATION = '23505';
const PROVIDER_OVERLAP = 'appointments_provider_no_overlap';
const PATIENT_OVERLAP = 'appointments_patient_no_overlap';
const IDEMPOTENCY_KEY_INDEX = 'appointments_idempotency_key_unique';
const RESCHEDULED_REASON = 'Rescheduled';

/**
 * Who is asking for the booking rules to apply.
 * - `staff`: a person at the front desk. The provider's hours, days off and existing appointments still apply, and
 *   the time cannot be in the past, but the caller-facing limits (minimum notice, furthest ahead) do not.
 * - `caller`: the AI receptionist acting for a caller. Every practice rule applies, including the cancellation window.
 */
export type BookingMode = 'staff' | 'caller';

/** A caller may not cancel or move an appointment this close to it: the AI takes a message for staff instead. */
export class CancellationWindowError extends ConflictException {
  constructor(readonly minHours: number) {
    super(`Appointments cannot be cancelled or moved within ${minHours} hours of the visit; please contact the practice`);
  }
}

export interface BookInput {
  patientId: string;
  providerId: string;
  appointmentTypeId: string;
  startsAt: Date;
  /** Booking again with the same key returns the same appointment instead of making another. */
  idempotencyKey: string;
  /** The conversation that made the booking (the AI receptionist's), kept on the appointment for review. */
  conversationId?: string | null;
}

export interface RescheduleInput {
  startsAt: Date;
  /** Another provider who offers the same visit; the same provider when left out. */
  providerId?: string;
  idempotencyKey: string;
  conversationId?: string | null;
}

interface AppointmentRow {
  id: string;
  patient_id: string;
  patient_first_name: string;
  patient_last_name: string;
  provider_id: string;
  provider_name: string;
  appointment_type_id: string;
  appointment_type_name: string;
  starts_at: Date;
  ends_at: Date;
  status: AppointmentStatus;
  booked_by_type: 'user' | 'ai';
  cancelled_at: Date | null;
  cancel_reason: string;
  rescheduled_from_id: string | null;
}

const toAppointment = (row: AppointmentRow): Appointment => ({
  id: row.id,
  patient: { id: row.patient_id, firstName: row.patient_first_name, lastName: row.patient_last_name },
  providerId: row.provider_id,
  providerName: row.provider_name,
  appointmentTypeId: row.appointment_type_id,
  appointmentTypeName: row.appointment_type_name,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  status: row.status,
  bookedBy: row.booked_by_type,
  cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
  cancelReason: row.cancel_reason,
  rescheduledFromId: row.rescheduled_from_id,
});

const databaseError = (error: unknown): { code?: string; constraint?: string } =>
  typeof error === 'object' && error !== null ? (error as { code?: string; constraint?: string }) : {};

/** The same booking request arriving twice at the same instant: the second one lost the race on the key. */
const lostIdempotencyRace = (error: unknown): boolean => databaseError(error).code === UNIQUE_VIOLATION && databaseError(error).constraint === IDEMPOTENCY_KEY_INDEX;

/**
 * What the database refused, in words a person can act on. The database is the final judge of double
 * booking: the checks in code only decide what to offer, this decides what can exist.
 */
export function translateBookingError(error: unknown): unknown {
  const { code, constraint } = databaseError(error);
  if (code === EXCLUSION_VIOLATION && constraint === PROVIDER_OVERLAP) return new ConflictException('That time was just taken');
  if (code === EXCLUSION_VIOLATION && constraint === PATIENT_OVERLAP) return new ConflictException('The patient already has an appointment at that time');
  return error;
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly scheduling: SchedulingService,
  ) {}

  // -------------------------------------------------------------------- reads

  list(auth: AuthContext, query: AppointmentListQuery): Promise<Appointment[]> {
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to ? new Date(query.to) : new Date(from.getTime() + APPOINTMENT_LIST_DEFAULT_DAYS * DAY);
    if (!(to.getTime() > from.getTime())) {
      throw new BadRequestException('"to" must be after "from"');
    }
    if (to.getTime() - from.getTime() > APPOINTMENT_WINDOW_MAX_DAYS * DAY) {
      throw new BadRequestException(`Look at most ${APPOINTMENT_WINDOW_MAX_DAYS} days at a time`);
    }
    const status = query.status ?? 'booked';
    return this.tenant.run(auth, async (trx) => {
      let select = this.baseQuery(trx).where('a.ends_at', '>', from).where('a.starts_at', '<', to);
      if (status !== 'all') select = select.where('a.status', '=', status);
      if (query.providerId) select = select.where('a.provider_id', '=', query.providerId);
      if (query.patientId) select = select.where('a.patient_id', '=', query.patientId);
      const rows = await select.orderBy('a.starts_at').orderBy('a.id').limit(query.limit ?? APPOINTMENT_LIST_LIMIT_DEFAULT).execute();
      return rows.map(toAppointment);
    });
  }

  get(auth: AuthContext, id: string): Promise<Appointment> {
    return this.tenant.run(auth, (trx) => this.load(trx, id));
  }

  // ------------------------------------------------- staff entry points (HTTP)

  async book(auth: AuthContext, input: BookInput, meta: RequestMeta): Promise<{ appointment: Appointment; replayed: boolean }> {
    const actor: SchedulingActor = { kind: 'user', userId: auth.userId };
    return this.runWithRetry(auth, (trx) => this.bookInTransaction(trx, auth.practiceId, actor, input, meta, 'staff'));
  }

  async cancel(auth: AuthContext, id: string, reason: string | undefined, meta: RequestMeta): Promise<Appointment> {
    const actor: SchedulingActor = { kind: 'user', userId: auth.userId };
    return this.tenant.run(auth, async (trx) => {
      await this.cancelInTransaction(trx, auth.practiceId, actor, id, reason ?? '', meta, 'staff');
      return this.load(trx, id);
    });
  }

  async reschedule(auth: AuthContext, id: string, input: RescheduleInput, meta: RequestMeta): Promise<{ appointment: Appointment; replayed: boolean }> {
    const actor: SchedulingActor = { kind: 'user', userId: auth.userId };
    return this.runWithRetry(auth, (trx) => this.rescheduleInTransaction(trx, auth.practiceId, actor, id, input, meta, 'staff'));
  }

  /** Runs a booking transaction. If the same request raced itself on the idempotency key, the second try finds the first's result. */
  private async runWithRetry(auth: AuthContext, work: (trx: Trx) => Promise<{ appointmentId: string; replayed: boolean }>): Promise<{ appointment: Appointment; replayed: boolean }> {
    const attempt = () =>
      this.tenant.run(auth, async (trx) => {
        const { appointmentId, replayed } = await work(trx);
        return { appointment: await this.load(trx, appointmentId), replayed };
      });
    try {
      return await attempt();
    } catch (error) {
      if (lostIdempotencyRace(error)) {
        return attempt();
      }
      throw translateBookingError(error);
    }
  }

  // ------------------------- the rules, shared by staff and the AI receptionist

  /**
   * Books an appointment inside an existing practice-scoped transaction. The same code serves the staff endpoint
   * and the AI receptionist's tool, so both follow the same rules, storage and audit. Throws an HTTP exception
   * for anything the rules refuse; a database refusal (the time was just taken) is turned into words by
   * `translateBookingError` outside the transaction.
   */
  async bookInTransaction(
    trx: Trx,
    practiceId: string,
    actor: SchedulingActor,
    input: BookInput,
    meta: RequestMeta,
    mode: BookingMode,
  ): Promise<{ appointmentId: string; replayed: boolean }> {
    const earlier = await this.findByKey(trx, input.idempotencyKey);
    if (earlier) {
      const sameRequest =
        earlier.rescheduled_from_id === null &&
        earlier.patient_id === input.patientId &&
        earlier.provider_id === input.providerId &&
        earlier.appointment_type_id === input.appointmentTypeId &&
        earlier.starts_at.getTime() === input.startsAt.getTime();
      if (!sameRequest) {
        throw new ConflictException('That idempotency key was already used for a different request');
      }
      return { appointmentId: earlier.id, replayed: true };
    }
    const appointmentId = await this.createRow(trx, practiceId, actor, input, meta, mode, null);
    return { appointmentId, replayed: false };
  }

  /** Cancels a booked appointment. A cancelled appointment frees its time and is kept as a record. */
  async cancelInTransaction(trx: Trx, practiceId: string, actor: SchedulingActor, id: string, reason: string, meta: RequestMeta, mode: BookingMode): Promise<void> {
    const current = await this.lockBooked(trx, id);
    if (mode === 'caller') await this.requireOutsideCancellationWindow(trx, practiceId, current.starts_at);
    await this.markCancelled(trx, actor, id, reason);
    await writeAuditLog(trx, {
      practiceId,
      ...auditActor(actor),
      action: 'appointment.cancelled',
      targetType: 'appointment',
      targetId: id,
      requestId: meta.requestId,
      ip: meta.ip,
      metadata: { patientId: current.patient_id, providerId: current.provider_id, source: actor.kind },
    });
  }

  /**
   * Moves an appointment: the new time is booked and the old one released in the same transaction, or
   * neither happens. The new appointment points back at the one it replaced.
   */
  async rescheduleInTransaction(
    trx: Trx,
    practiceId: string,
    actor: SchedulingActor,
    id: string,
    input: RescheduleInput,
    meta: RequestMeta,
    mode: BookingMode,
  ): Promise<{ appointmentId: string; replayed: boolean }> {
    const earlier = await this.findByKey(trx, input.idempotencyKey);
    if (earlier) {
      const sameRequest =
        earlier.rescheduled_from_id === id &&
        earlier.starts_at.getTime() === input.startsAt.getTime() &&
        (input.providerId === undefined || earlier.provider_id === input.providerId);
      if (!sameRequest) {
        throw new ConflictException('That idempotency key was already used for a different request');
      }
      return { appointmentId: earlier.id, replayed: true };
    }

    const current = await this.lockBooked(trx, id);
    if (mode === 'caller') await this.requireOutsideCancellationWindow(trx, practiceId, current.starts_at);
    const providerId = input.providerId ?? current.provider_id;
    if (providerId === current.provider_id && input.startsAt.getTime() === current.starts_at.getTime()) {
      throw new BadRequestException('Choose a different time or provider');
    }
    // Release the old time before taking the new one, so a move to an overlapping time is not refused by its
    // own predecessor. If the new time is not available this throws and the release is rolled back with it.
    await this.markCancelled(trx, actor, id, RESCHEDULED_REASON);
    const appointmentId = await this.createRow(
      trx,
      practiceId,
      actor,
      {
        patientId: current.patient_id,
        providerId,
        appointmentTypeId: current.appointment_type_id,
        startsAt: input.startsAt,
        idempotencyKey: input.idempotencyKey,
        conversationId: input.conversationId ?? null,
      },
      meta,
      mode,
      id,
    );
    return { appointmentId, replayed: false };
  }

  // ----------------------------------------------------------------- internals

  private async createRow(trx: Trx, practiceId: string, actor: SchedulingActor, input: BookInput, meta: RequestMeta, mode: BookingMode, replacesId: string | null): Promise<string> {
    const patient = await trx.selectFrom('patients').select('id').where('id', '=', input.patientId).executeTakeFirst();
    if (!patient) {
      throw new NotFoundException('Patient not found');
    }
    const type = await this.requireOffered(trx, practiceId, input, mode);
    const endsAt = new Date(input.startsAt.getTime() + type.duration_minutes * MINUTE);
    const { id } = await trx
      .insertInto('appointments')
      .values({
        practice_id: practiceId,
        patient_id: input.patientId,
        provider_id: input.providerId,
        appointment_type_id: input.appointmentTypeId,
        starts_at: input.startsAt,
        ends_at: endsAt,
        booked_by_type: actor.kind,
        booked_by: actor.kind === 'user' ? actor.userId : null,
        rescheduled_from_id: replacesId,
        idempotency_key: input.idempotencyKey,
        conversation_id: input.conversationId ?? null,
        cancelled_at: null,
        cancelled_by_type: null,
        cancelled_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAuditLog(trx, {
      practiceId,
      ...auditActor(actor),
      action: replacesId ? 'appointment.rescheduled' : 'appointment.booked',
      targetType: 'appointment',
      targetId: id,
      requestId: meta.requestId,
      ip: meta.ip,
      // Identifiers only: never the patient's name, date of birth or phone.
      metadata: {
        patientId: input.patientId,
        providerId: input.providerId,
        appointmentTypeId: input.appointmentTypeId,
        source: actor.kind,
        ...(replacesId ? { fromAppointmentId: replacesId } : {}),
      },
    });
    return id;
  }

  /**
   * Checks that this provider can really be booked for this visit at this exact time, by the same code that
   * works out what to offer, and returns the visit type. The time must be one that would be offered right now.
   */
  private async requireOffered(
    trx: Trx,
    practiceId: string,
    request: { providerId: string; appointmentTypeId: string; startsAt: Date },
    mode: BookingMode,
  ): Promise<{ id: string; duration_minutes: number }> {
    const type = await trx.selectFrom('appointment_types').select(['id', 'duration_minutes']).where('id', '=', request.appointmentTypeId).where('active', '=', true).executeTakeFirst();
    if (!type) {
      throw new NotFoundException('Appointment type not found');
    }
    const provider = await trx.selectFrom('providers').select(['id', 'hours']).where('id', '=', request.providerId).where('active', '=', true).executeTakeFirst();
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }
    const offers = await trx.selectFrom('provider_appointment_types').select('provider_id').where('provider_id', '=', provider.id).where('appointment_type_id', '=', type.id).executeTakeFirst();
    if (!offers) {
      throw new BadRequestException('That provider does not offer this appointment type');
    }

    const endsAt = new Date(request.startsAt.getTime() + type.duration_minutes * MINUTE);
    const practice = await trx.selectFrom('practices').select('timezone').where('id', '=', practiceId).executeTakeFirstOrThrow();
    const settings = await this.scheduling.loadSettings(trx, practiceId);
    const timeOff = await trx
      .selectFrom('provider_time_off')
      .select(['starts_at', 'ends_at'])
      .where('provider_id', '=', provider.id)
      .where('active', '=', true)
      .where('starts_at', '<', endsAt)
      .where('ends_at', '>', request.startsAt)
      .execute();
    const busy = (await loadBusy(trx, [provider.id], request.startsAt, endsAt)).get(provider.id) ?? [];
    const rules =
      mode === 'staff'
        ? { slotMinutes: settings.slotMinutes, minNoticeHours: 0, maxAdvanceDays: MAX_ADVANCE_DAYS_MAX }
        : { slotMinutes: settings.slotMinutes, minNoticeHours: settings.minNoticeHours, maxAdvanceDays: settings.maxAdvanceDays };
    const offered = isSlotOffered(
      { id: provider.id, hours: normalizeBusinessHours(provider.hours), timeOff: timeOff.map((row): Interval => ({ startsAt: row.starts_at, endsAt: row.ends_at })), busy },
      { timeZone: practice.timezone, rules, durationMinutes: type.duration_minutes, now: new Date() },
      request.startsAt,
    );
    if (!offered) {
      throw new ConflictException('That time is not available');
    }
    return type;
  }

  private async requireOutsideCancellationWindow(trx: Trx, practiceId: string, startsAt: Date): Promise<void> {
    const { cancelMinHours } = await this.scheduling.loadSettings(trx, practiceId);
    if (startsAt.getTime() - Date.now() < cancelMinHours * HOUR) {
      throw new CancellationWindowError(cancelMinHours);
    }
  }

  /** Locks the appointment so two people changing it at once are handled one after the other. */
  private async lockBooked(trx: Trx, id: string): Promise<{ patient_id: string; provider_id: string; appointment_type_id: string; starts_at: Date }> {
    const current = await trx
      .selectFrom('appointments')
      .select(['status', 'patient_id', 'provider_id', 'appointment_type_id', 'starts_at'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) {
      throw new NotFoundException('Appointment not found');
    }
    if (current.status === 'cancelled') {
      throw new ConflictException('Already cancelled');
    }
    if (current.status !== 'booked') {
      throw new ConflictException('Only a booked appointment can be cancelled or moved');
    }
    return current;
  }

  private async markCancelled(trx: Trx, actor: SchedulingActor, id: string, reason: string): Promise<void> {
    await trx
      .updateTable('appointments')
      .set({
        status: 'cancelled',
        cancelled_at: sql<Date>`now()`,
        cancelled_by_type: actor.kind,
        cancelled_by: actor.kind === 'user' ? actor.userId : null,
        cancel_reason: reason,
      })
      .where('id', '=', id)
      .execute();
  }

  private findByKey(trx: Trx, key: string) {
    return trx
      .selectFrom('appointments')
      .select(['id', 'patient_id', 'provider_id', 'appointment_type_id', 'starts_at', 'rescheduled_from_id'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private baseQuery(trx: Trx) {
    return trx
      .selectFrom('appointments as a')
      .innerJoin('patients as p', 'p.id', 'a.patient_id')
      .innerJoin('providers as pr', 'pr.id', 'a.provider_id')
      .innerJoin('appointment_types as t', 't.id', 'a.appointment_type_id')
      .select([
        'a.id',
        'a.patient_id',
        'p.first_name as patient_first_name',
        'p.last_name as patient_last_name',
        'a.provider_id',
        'pr.name as provider_name',
        'a.appointment_type_id',
        't.name as appointment_type_name',
        'a.starts_at',
        'a.ends_at',
        'a.status',
        'a.booked_by_type',
        'a.cancelled_at',
        'a.cancel_reason',
        'a.rescheduled_from_id',
      ]);
  }

  async load(trx: Trx, id: string): Promise<Appointment> {
    const row = await this.baseQuery(trx).where('a.id', '=', id).executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Appointment not found');
    }
    return toAppointment(row);
  }
}
