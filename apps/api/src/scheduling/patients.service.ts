import { Injectable, NotFoundException } from '@nestjs/common';
import { PATIENT_SEARCH_LIMIT_DEFAULT, type Patient } from '@frontdesk/shared';
import { type Kysely, sql, type Transaction } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { auditActor, type SchedulingActor } from './actor.js';
import type { CreatePatientDto, PatientSearchQuery } from './appointments.dto.js';

type Trx = Transaction<Database>;

interface PatientRow {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  phone: string;
  created_at: Date;
}

/** A date of birth must be read as text: the driver would turn a `date` into a JS Date in the server's own time zone. */
const patientColumns = [
  'id',
  'first_name',
  'last_name',
  sql<string>`date_of_birth::text`.as('date_of_birth'),
  'phone',
  'created_at',
] as const;

const toPatient = (row: PatientRow): Patient => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  dateOfBirth: row.date_of_birth,
  phone: row.phone,
  createdAt: row.created_at.toISOString(),
});

/** Makes a piece of text safe to use inside LIKE (the user's % and _ mean themselves). */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/** Patient details are personal health information: never logged, and never put in audit metadata. */
@Injectable()
export class PatientsService {
  constructor(private readonly tenant: TenantDb) {}

  /**
   * Finds patients by name (each word may be the start of a first or last name) or by part of a phone number.
   * Needs at least two characters, shows at most a few, and is audited (how many were shown, never the search text).
   */
  search(auth: AuthContext, query: PatientSearchQuery, meta: RequestMeta): Promise<Patient[]> {
    const words = query.q.split(/\s+/).filter(Boolean).slice(0, 4);
    return this.tenant.run(auth, async (trx) => {
      let select = trx.selectFrom('patients').select(patientColumns);
      for (const word of words) {
        const digits = word.replace(/\D/g, '');
        if (/^\+?[\d-]+$/.test(word) && digits.length >= 3) {
          select = select.where('phone', 'like', `%${digits}%`);
        } else {
          const pattern = `${escapeLike(word)}%`;
          select = select.where(sql<boolean>`(lower(first_name) like lower(${pattern}) escape '\\' or lower(last_name) like lower(${pattern}) escape '\\')`);
        }
      }
      const rows = await select
        .orderBy('last_name')
        .orderBy('first_name')
        .orderBy('id')
        .limit(query.limit ?? PATIENT_SEARCH_LIMIT_DEFAULT)
        .execute();
      await writeAuditLog(trx, {
        practiceId: auth.practiceId,
        actorUserId: auth.userId,
        action: 'patient.searched',
        requestId: meta.requestId,
        ip: meta.ip,
        metadata: { resultCount: rows.length },
      });
      return rows.map(toPatient);
    });
  }

  get(auth: AuthContext, id: string, meta: RequestMeta): Promise<Patient> {
    return this.tenant.run(auth, async (trx) => {
      const row = await trx.selectFrom('patients').select(patientColumns).where('id', '=', id).executeTakeFirst();
      if (!row) {
        throw new NotFoundException('Patient not found');
      }
      await writeAuditLog(trx, {
        practiceId: auth.practiceId,
        actorUserId: auth.userId,
        action: 'patient.viewed',
        targetType: 'patient',
        targetId: id,
        requestId: meta.requestId,
        ip: meta.ip,
      });
      return toPatient(row);
    });
  }

  /** Reuses the patient who already matches on name, date of birth and phone; otherwise adds one. */
  findOrCreate(auth: AuthContext, dto: CreatePatientDto, meta: RequestMeta): Promise<{ patient: Patient; created: boolean }> {
    return this.tenant.run(auth, (trx) => this.findOrCreateInTransaction(trx, auth.practiceId, { kind: 'user', userId: auth.userId }, dto, meta));
  }

  /** Shared by the staff endpoint and (later) the AI receptionist's booking, so both follow the same rules. */
  async findOrCreateInTransaction(
    trx: Trx,
    practiceId: string,
    actor: SchedulingActor,
    input: CreatePatientDto,
    meta: RequestMeta,
  ): Promise<{ patient: Patient; created: boolean }> {
    const existing = await this.findMatch(trx, input);
    if (existing) {
      return { patient: existing, created: false };
    }
    // If two requests add the same person at once, the unique index keeps one and the other simply finds it.
    const inserted = await trx
      .insertInto('patients')
      .values({
        practice_id: practiceId,
        first_name: input.firstName,
        last_name: input.lastName,
        date_of_birth: input.dateOfBirth,
        phone: input.phone,
        created_by_type: actor.kind,
        created_by: actor.kind === 'user' ? actor.userId : null,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning(patientColumns)
      .executeTakeFirst();
    if (!inserted) {
      const winner = await this.findMatch(trx, input);
      if (!winner) throw new Error('patient insert conflicted but no matching patient was found');
      return { patient: winner, created: false };
    }
    await writeAuditLog(trx, {
      practiceId,
      ...auditActor(actor),
      action: 'patient.created',
      targetType: 'patient',
      targetId: inserted.id,
      requestId: meta.requestId,
      ip: meta.ip,
      metadata: { source: actor.kind },
    });
    return { patient: toPatient(inserted), created: true };
  }

  /** The patient who matches on all four details (names without regard to capital letters), if any. */
  async findMatch(db: Kysely<Database>, input: Pick<CreatePatientDto, 'firstName' | 'lastName' | 'dateOfBirth' | 'phone'>): Promise<Patient | null> {
    const row = await db
      .selectFrom('patients')
      .select(patientColumns)
      .where(sql<boolean>`lower(first_name) = lower(${input.firstName})`)
      .where(sql<boolean>`lower(last_name) = lower(${input.lastName})`)
      .where(sql<boolean>`date_of_birth = ${input.dateOfBirth}::date`)
      .where('phone', '=', input.phone)
      .executeTakeFirst();
    return row ? toPatient(row) : null;
  }
}
