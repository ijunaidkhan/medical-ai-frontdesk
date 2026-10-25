import { Injectable } from '@nestjs/common';
import type { Appointment } from '@frontdesk/shared';
import { sql } from 'kysely';
import type { SchedulingActor } from '../actor.js';
import { AppointmentsService, translateBookingError } from '../appointments.service.js';
import { PatientsService } from '../patients.service.js';
import { SchedulingService } from '../scheduling.service.js';
import type { AppointmentRecord, BookRequest, GatewayScope, MoveRequest, PatientQuery, PatientRef, SchedulingGateway, SlotSearch, VisitType } from './scheduling-gateway.js';

const AI: SchedulingActor = { kind: 'ai' };

/** The database's refusal of a double booking becomes a `ConflictException`, as the gateway promises. */
async function refusedInWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translateBookingError(error);
  }
}

const toRecord = (appointment: Appointment): AppointmentRecord => ({
  id: appointment.id,
  patientId: appointment.patient.id,
  appointmentTypeId: appointment.appointmentTypeId,
  facts: { typeName: appointment.appointmentTypeName, providerName: appointment.providerName, startsAt: new Date(appointment.startsAt) },
});

/** The practice's calendar in our own tables, through the same services and rules the staff screens use. */
@Injectable()
export class NativeAdapter implements SchedulingGateway {
  constructor(
    private readonly scheduling: SchedulingService,
    private readonly appointments: AppointmentsService,
    private readonly patients: PatientsService,
  ) {}

  /** Active visit types with at least one active provider who offers them. */
  async listVisitTypes({ trx }: GatewayScope): Promise<VisitType[]> {
    const rows = await trx
      .selectFrom('appointment_types as t')
      .select(['t.id', 't.name', 't.duration_minutes'])
      .where('t.active', '=', true)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('provider_appointment_types as link')
            .innerJoin('providers as p', 'p.id', 'link.provider_id')
            .select('link.provider_id')
            .whereRef('link.appointment_type_id', '=', 't.id')
            .where('p.active', '=', true),
        ),
      )
      .orderBy('t.name')
      .limit(30)
      .execute();
    return rows.map((row) => ({ id: row.id, name: row.name, durationMinutes: row.duration_minutes }));
  }

  async findSlots({ trx, practiceId }: GatewayScope, query: SlotSearch) {
    return (await this.scheduling.findSlots(trx, practiceId, query)).slots;
  }

  async findPatient({ trx }: GatewayScope, query: PatientQuery): Promise<PatientRef | null> {
    const patient = 'fullName' in query ? await this.patients.findByNameAndBirth(trx, query.fullName, query.dateOfBirth) : await this.patients.findMatch(trx, query);
    return patient ? { id: patient.id, phone: patient.phone } : null;
  }

  async listAppointments({ trx }: GatewayScope, patientId: string, limit: number): Promise<AppointmentRecord[]> {
    const rows = await trx
      .selectFrom('appointments')
      .select('id')
      .where('patient_id', '=', patientId)
      .where('status', '=', 'booked')
      .where('starts_at', '>', sql<Date>`now()`)
      .orderBy('starts_at')
      .orderBy('id')
      .limit(limit)
      .execute();
    const records: AppointmentRecord[] = [];
    for (const row of rows) records.push(toRecord(await this.appointments.load(trx, row.id)));
    return records;
  }

  async getAppointment({ trx }: GatewayScope, appointmentId: string): Promise<AppointmentRecord | null> {
    const row = await trx.selectFrom('appointments').select('id').where('id', '=', appointmentId).executeTakeFirst();
    return row ? toRecord(await this.appointments.load(trx, row.id)) : null;
  }

  async book({ trx, practiceId, meta }: GatewayScope, request: BookRequest): Promise<AppointmentRecord> {
    const patientId = 'id' in request.patient ? request.patient.id : (await this.patients.findOrCreateInTransaction(trx, practiceId, AI, request.patient.create, meta)).patient.id;
    const { appointmentId } = await refusedInWords(() =>
      this.appointments.bookInTransaction(
        trx,
        practiceId,
        AI,
        {
          patientId,
          providerId: request.providerId,
          appointmentTypeId: request.appointmentTypeId,
          startsAt: request.startsAt,
          idempotencyKey: request.idempotencyKey,
          conversationId: request.conversationId,
        },
        meta,
        'caller',
      ),
    );
    return toRecord(await this.appointments.load(trx, appointmentId));
  }

  async cancel({ trx, practiceId, meta }: GatewayScope, appointmentId: string, reason: string): Promise<void> {
    await this.appointments.cancelInTransaction(trx, practiceId, AI, appointmentId, reason, meta, 'caller');
  }

  async reschedule({ trx, practiceId, meta }: GatewayScope, appointmentId: string, request: MoveRequest): Promise<AppointmentRecord> {
    const { appointmentId: movedId } = await refusedInWords(() => this.appointments.rescheduleInTransaction(trx, practiceId, AI, appointmentId, request, meta, 'caller'));
    return toRecord(await this.appointments.load(trx, movedId));
  }
}
