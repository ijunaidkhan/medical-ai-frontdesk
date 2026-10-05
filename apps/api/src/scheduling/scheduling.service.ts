import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AVAILABILITY_LIMIT_DEFAULT,
  AVAILABILITY_WINDOW_MAX_DAYS,
  hasAnyOpeningHours,
  MAX_APPOINTMENT_TYPES,
  MAX_PROVIDERS,
  normalizeBusinessHours,
  SCHEDULING_DEFAULTS,
  type AppointmentType,
  type AvailabilityResponse,
  type Provider,
  type ProviderTimeOff,
  type SchedulingSettings,
  type SlotMinutes,
} from '@frontdesk/shared';
import { type Kysely, sql, type Transaction } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { computeSlotsForProviders, type Interval, type ProviderSchedule } from './availability.js';
import { loadBusy } from './busy.js';
import type {
  AvailabilityQuery,
  CreateAppointmentTypeDto,
  CreateProviderDto,
  CreateTimeOffDto,
  UpdateAppointmentTypeDto,
  UpdateProviderDto,
  UpdateSchedulingSettingsDto,
} from './scheduling.dto.js';

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const DAY = 86_400_000;
const MINUTE = 60_000;
/** A stretch of time off may not be longer than this. */
const TIME_OFF_MAX_DAYS = 366;
/** Searches look at most this far at once, and by default this far ahead. */
const DEFAULT_SEARCH_DAYS = 14;

const hasCode = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code;

type Trx = Transaction<Database>;

@Injectable()
export class SchedulingService {
  constructor(private readonly tenant: TenantDb) {}

  // ------------------------------------------------------------ booking rules

  getSettings(auth: AuthContext): Promise<SchedulingSettings> {
    return this.tenant.run(auth, (trx) => this.loadSettings(trx, auth.practiceId));
  }

  updateSettings(auth: AuthContext, dto: UpdateSchedulingSettingsDto, meta: RequestMeta): Promise<SchedulingSettings> {
    return this.tenant.run(auth, async (trx) => {
      // Lock the row (when there is one) so two people changing rules at once are applied one after the other.
      await trx.selectFrom('scheduling_settings').select('practice_id').where('practice_id', '=', auth.practiceId).forUpdate().executeTakeFirst();
      const current = await this.loadSettings(trx, auth.practiceId);

      const changes = {} as Record<string, number | boolean | string>;
      const fields: string[] = [];
      const note = <K extends 'slotMinutes' | 'minNoticeHours' | 'maxAdvanceDays' | 'cancelMinHours' | 'aiBookingEnabled' | 'timeFormat' | 'identityFailureCapPerHour'>(key: K, column: string) => {
        const value = dto[key];
        if (value !== undefined && value !== current[key]) {
          changes[column] = value;
          fields.push(key);
        }
      };
      note('slotMinutes', 'slot_minutes');
      note('minNoticeHours', 'min_notice_hours');
      note('maxAdvanceDays', 'max_advance_days');
      note('cancelMinHours', 'cancel_min_hours');
      note('aiBookingEnabled', 'ai_booking_enabled');
      note('timeFormat', 'time_format');
      note('identityFailureCapPerHour', 'identity_failure_cap_per_hour');
      if (fields.length === 0) {
        throw new BadRequestException('Nothing to change');
      }

      // The AI may only book once there is something it could really book. Turning it off is always allowed.
      if (dto.aiBookingEnabled === true && !current.aiBookingEnabled) {
        const problems = await this.bookingReadinessProblems(trx);
        if (problems.length > 0) {
          throw new ConflictException(problems);
        }
      }

      await trx
        .insertInto('scheduling_settings')
        .values({ practice_id: auth.practiceId, ...changes, updated_by: auth.userId })
        .onConflict((conflict) => conflict.column('practice_id').doUpdateSet({ ...changes, updated_by: auth.userId }))
        .execute();

      const ruleFields = fields.filter((field) => field !== 'aiBookingEnabled');
      if (ruleFields.length > 0) await this.audit(trx, auth, meta, 'scheduling.settings_updated', 'scheduling_settings', auth.practiceId, { fields: ruleFields });
      if (fields.includes('aiBookingEnabled')) {
        await this.audit(trx, auth, meta, dto.aiBookingEnabled ? 'scheduling.ai_booking_enabled' : 'scheduling.ai_booking_disabled', 'scheduling_settings', auth.practiceId, {});
      }
      return this.loadSettings(trx, auth.practiceId);
    });
  }

  async loadSettings(trx: Trx, practiceId: string): Promise<SchedulingSettings> {
    const row = await trx.selectFrom('scheduling_settings').selectAll().where('practice_id', '=', practiceId).executeTakeFirst();
    if (!row) {
      return { ...SCHEDULING_DEFAULTS, updatedAt: null };
    }
    return {
      slotMinutes: row.slot_minutes as SlotMinutes,
      minNoticeHours: row.min_notice_hours,
      maxAdvanceDays: row.max_advance_days,
      cancelMinHours: row.cancel_min_hours,
      aiBookingEnabled: row.ai_booking_enabled,
      timeFormat: row.time_format,
      identityFailureCapPerHour: row.identity_failure_cap_per_hour,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /** What still stops the AI from being allowed to book: there must be someone with hours who offers a visit type. */
  private async bookingReadinessProblems(trx: Trx): Promise<string[]> {
    const providers = await trx.selectFrom('providers').select(['id', 'hours']).where('active', '=', true).execute();
    const offered = await trx
      .selectFrom('provider_appointment_types as link')
      .innerJoin('appointment_types as type', 'type.id', 'link.appointment_type_id')
      .select('link.provider_id')
      .where('type.active', '=', true)
      .execute();
    const offering = new Set(offered.map((row) => row.provider_id));
    const problems: string[] = [];
    if (providers.length === 0) problems.push('Add at least one provider');
    else if (!providers.some((provider) => hasAnyOpeningHours(normalizeBusinessHours(provider.hours)))) problems.push('Give a provider working hours');
    else if (!providers.some((provider) => offering.has(provider.id) && hasAnyOpeningHours(normalizeBusinessHours(provider.hours)))) {
      problems.push('Add an appointment type and choose which provider offers it');
    }
    return problems;
  }

  // ---------------------------------------------------------------- providers

  listProviders(auth: AuthContext): Promise<Provider[]> {
    return this.tenant.run(auth, async (trx) => {
      const rows = await trx.selectFrom('providers').selectAll().orderBy('active', 'desc').orderBy('name').orderBy('id').limit(MAX_PROVIDERS).execute();
      const links = await trx.selectFrom('provider_appointment_types').select(['provider_id', 'appointment_type_id']).execute();
      return rows.map((row) => this.toProvider(row, links.filter((link) => link.provider_id === row.id).map((link) => link.appointment_type_id)));
    });
  }

  getProvider(auth: AuthContext, id: string): Promise<Provider> {
    return this.tenant.run(auth, (trx) => this.loadProvider(trx, id));
  }

  async createProvider(auth: AuthContext, dto: CreateProviderDto, meta: RequestMeta): Promise<Provider> {
    try {
      return await this.tenant.run(auth, async (trx) => {
        const count = await trx.selectFrom('providers').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
        if (Number(count.n) >= MAX_PROVIDERS) {
          throw new ConflictException(`A practice can have at most ${MAX_PROVIDERS} providers`);
        }
        const { id } = await trx
          .insertInto('providers')
          .values({
            practice_id: auth.practiceId,
            name: dto.name,
            title: dto.title ?? '',
            ...(dto.hours !== undefined && { hours: normalizeBusinessHours(dto.hours) }),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const typeIds = dto.appointmentTypeIds ?? [];
        if (typeIds.length > 0) {
          await trx.insertInto('provider_appointment_types').values(typeIds.map((typeId) => ({ practice_id: auth.practiceId, provider_id: id, appointment_type_id: typeId }))).execute();
        }
        await this.audit(trx, auth, meta, 'provider.created', 'provider', id, {});
        return this.loadProvider(trx, id);
      });
    } catch (error) {
      if (hasCode(error, FOREIGN_KEY_VIOLATION)) throw new BadRequestException('One of the appointment types does not exist');
      throw error;
    }
  }

  async updateProvider(auth: AuthContext, id: string, dto: UpdateProviderDto, meta: RequestMeta): Promise<Provider> {
    try {
      return await this.tenant.run(auth, async (trx) => {
        const current = await trx.selectFrom('providers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) {
          throw new NotFoundException('Provider not found');
        }
        const set: { name?: string; title?: string; hours?: ReturnType<typeof normalizeBusinessHours>; active?: boolean } = {};
        const fields: string[] = [];
        if (dto.name !== undefined && dto.name !== current.name) {
          set.name = dto.name;
          fields.push('name');
        }
        if (dto.title !== undefined && dto.title !== current.title) {
          set.title = dto.title;
          fields.push('title');
        }
        if (dto.hours !== undefined) {
          const hours = normalizeBusinessHours(dto.hours);
          if (JSON.stringify(hours) !== JSON.stringify(normalizeBusinessHours(current.hours))) {
            set.hours = hours;
            fields.push('hours');
          }
        }
        if (dto.active !== undefined && dto.active !== current.active) {
          set.active = dto.active;
          fields.push('active');
        }

        let added: string[] = [];
        let removed: string[] = [];
        if (dto.appointmentTypeIds !== undefined) {
          const existing = (await trx.selectFrom('provider_appointment_types').select('appointment_type_id').where('provider_id', '=', id).execute()).map((row) => row.appointment_type_id);
          added = dto.appointmentTypeIds.filter((typeId) => !existing.includes(typeId));
          removed = existing.filter((typeId) => !dto.appointmentTypeIds!.includes(typeId));
          if (added.length > 0 || removed.length > 0) fields.push('appointmentTypeIds');
        }
        if (fields.length === 0) {
          throw new BadRequestException('Nothing to change');
        }

        if (Object.keys(set).length > 0) await trx.updateTable('providers').set(set).where('id', '=', id).execute();
        if (removed.length > 0) await trx.deleteFrom('provider_appointment_types').where('provider_id', '=', id).where('appointment_type_id', 'in', removed).execute();
        if (added.length > 0) {
          await trx.insertInto('provider_appointment_types').values(added.map((typeId) => ({ practice_id: auth.practiceId, provider_id: id, appointment_type_id: typeId }))).execute();
        }
        await this.audit(trx, auth, meta, 'provider.updated', 'provider', id, { fields });
        return this.loadProvider(trx, id);
      });
    } catch (error) {
      if (hasCode(error, FOREIGN_KEY_VIOLATION)) throw new BadRequestException('One of the appointment types does not exist');
      throw error;
    }
  }

  private async loadProvider(trx: Kysely<Database>, id: string): Promise<Provider> {
    const row = await trx.selectFrom('providers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Provider not found');
    }
    const links = await trx.selectFrom('provider_appointment_types').select('appointment_type_id').where('provider_id', '=', id).orderBy('appointment_type_id').execute();
    return this.toProvider(row, links.map((link) => link.appointment_type_id));
  }

  private toProvider(row: { id: string; name: string; title: string; hours: unknown; active: boolean; created_at: Date; updated_at: Date }, typeIds: string[]): Provider {
    return {
      id: row.id,
      name: row.name,
      title: row.title,
      hours: normalizeBusinessHours(row.hours),
      active: row.active,
      appointmentTypeIds: [...typeIds].sort(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  // -------------------------------------------------------- appointment types

  listAppointmentTypes(auth: AuthContext): Promise<AppointmentType[]> {
    return this.tenant.run(auth, async (trx) => {
      const rows = await trx.selectFrom('appointment_types').selectAll().orderBy('active', 'desc').orderBy('name').orderBy('id').limit(MAX_APPOINTMENT_TYPES).execute();
      const links = await trx.selectFrom('provider_appointment_types').select(['provider_id', 'appointment_type_id']).execute();
      return rows.map((row) => this.toType(row, links.filter((link) => link.appointment_type_id === row.id).map((link) => link.provider_id)));
    });
  }

  async createAppointmentType(auth: AuthContext, dto: CreateAppointmentTypeDto, meta: RequestMeta): Promise<AppointmentType> {
    try {
      return await this.tenant.run(auth, async (trx) => {
        const count = await trx.selectFrom('appointment_types').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
        if (Number(count.n) >= MAX_APPOINTMENT_TYPES) {
          throw new ConflictException(`A practice can have at most ${MAX_APPOINTMENT_TYPES} appointment types`);
        }
        const { id } = await trx
          .insertInto('appointment_types')
          .values({ practice_id: auth.practiceId, name: dto.name, duration_minutes: dto.durationMinutes })
          .returning('id')
          .executeTakeFirstOrThrow();
        const providerIds = dto.providerIds ?? [];
        if (providerIds.length > 0) {
          await trx.insertInto('provider_appointment_types').values(providerIds.map((providerId) => ({ practice_id: auth.practiceId, provider_id: providerId, appointment_type_id: id }))).execute();
        }
        await this.audit(trx, auth, meta, 'appointment_type.created', 'appointment_type', id, { durationMinutes: dto.durationMinutes });
        return this.loadType(trx, id);
      });
    } catch (error) {
      if (hasCode(error, UNIQUE_VIOLATION)) throw new ConflictException('An appointment type with that name already exists');
      if (hasCode(error, FOREIGN_KEY_VIOLATION)) throw new BadRequestException('One of the providers does not exist');
      throw error;
    }
  }

  async updateAppointmentType(auth: AuthContext, id: string, dto: UpdateAppointmentTypeDto, meta: RequestMeta): Promise<AppointmentType> {
    try {
      return await this.tenant.run(auth, async (trx) => {
        const current = await trx.selectFrom('appointment_types').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) {
          throw new NotFoundException('Appointment type not found');
        }
        const set: { name?: string; duration_minutes?: number; active?: boolean } = {};
        const fields: string[] = [];
        if (dto.name !== undefined && dto.name !== current.name) {
          set.name = dto.name;
          fields.push('name');
        }
        if (dto.durationMinutes !== undefined && dto.durationMinutes !== current.duration_minutes) {
          set.duration_minutes = dto.durationMinutes;
          fields.push('durationMinutes');
        }
        if (dto.active !== undefined && dto.active !== current.active) {
          set.active = dto.active;
          fields.push('active');
        }
        let added: string[] = [];
        let removed: string[] = [];
        if (dto.providerIds !== undefined) {
          const existing = (await trx.selectFrom('provider_appointment_types').select('provider_id').where('appointment_type_id', '=', id).execute()).map((row) => row.provider_id);
          added = dto.providerIds.filter((providerId) => !existing.includes(providerId));
          removed = existing.filter((providerId) => !dto.providerIds!.includes(providerId));
          if (added.length > 0 || removed.length > 0) fields.push('providerIds');
        }
        if (fields.length === 0) {
          throw new BadRequestException('Nothing to change');
        }

        if (Object.keys(set).length > 0) await trx.updateTable('appointment_types').set(set).where('id', '=', id).execute();
        if (removed.length > 0) await trx.deleteFrom('provider_appointment_types').where('appointment_type_id', '=', id).where('provider_id', 'in', removed).execute();
        if (added.length > 0) {
          await trx.insertInto('provider_appointment_types').values(added.map((providerId) => ({ practice_id: auth.practiceId, provider_id: providerId, appointment_type_id: id }))).execute();
        }
        await this.audit(trx, auth, meta, 'appointment_type.updated', 'appointment_type', id, { fields });
        return this.loadType(trx, id);
      });
    } catch (error) {
      if (hasCode(error, UNIQUE_VIOLATION)) throw new ConflictException('An appointment type with that name already exists');
      if (hasCode(error, FOREIGN_KEY_VIOLATION)) throw new BadRequestException('One of the providers does not exist');
      throw error;
    }
  }

  private async loadType(trx: Kysely<Database>, id: string): Promise<AppointmentType> {
    const row = await trx.selectFrom('appointment_types').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Appointment type not found');
    }
    const links = await trx.selectFrom('provider_appointment_types').select('provider_id').where('appointment_type_id', '=', id).orderBy('provider_id').execute();
    return this.toType(row, links.map((link) => link.provider_id));
  }

  private toType(row: { id: string; name: string; duration_minutes: number; active: boolean }, providerIds: string[]): AppointmentType {
    return { id: row.id, name: row.name, durationMinutes: row.duration_minutes, active: row.active, providerIds: [...providerIds].sort() };
  }

  // ----------------------------------------------------------------- time off

  listTimeOff(auth: AuthContext, providerId: string): Promise<ProviderTimeOff[]> {
    return this.tenant.run(auth, async (trx) => {
      await this.requireProvider(trx, providerId);
      const rows = await trx
        .selectFrom('provider_time_off')
        .selectAll()
        .where('provider_id', '=', providerId)
        .where('active', '=', true)
        .where('ends_at', '>', sql<Date>`now()`)
        .orderBy('starts_at')
        .orderBy('id')
        .limit(200)
        .execute();
      return rows.map((row) => this.toTimeOff(row));
    });
  }

  createTimeOff(auth: AuthContext, providerId: string, dto: CreateTimeOffDto, meta: RequestMeta): Promise<ProviderTimeOff> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (!(endsAt.getTime() > startsAt.getTime())) {
      throw new BadRequestException('The end of the time off must be after its start');
    }
    if (endsAt.getTime() - startsAt.getTime() > TIME_OFF_MAX_DAYS * DAY) {
      throw new BadRequestException(`Time off can be at most ${TIME_OFF_MAX_DAYS} days long`);
    }
    return this.tenant.run(auth, async (trx) => {
      await this.requireProvider(trx, providerId);
      const row = await trx
        .insertInto('provider_time_off')
        .values({ practice_id: auth.practiceId, provider_id: providerId, starts_at: startsAt, ends_at: endsAt, reason: dto.reason ?? '', created_by: auth.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(trx, auth, meta, 'time_off.created', 'provider_time_off', row.id, { providerId });
      return this.toTimeOff(row);
    });
  }

  cancelTimeOff(auth: AuthContext, id: string, meta: RequestMeta): Promise<ProviderTimeOff> {
    return this.tenant.run(auth, async (trx) => {
      const current = await trx.selectFrom('provider_time_off').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) {
        throw new NotFoundException('Time off not found');
      }
      if (!current.active) {
        throw new ConflictException('Already cancelled');
      }
      await trx.updateTable('provider_time_off').set({ active: false }).where('id', '=', id).execute();
      await this.audit(trx, auth, meta, 'time_off.cancelled', 'provider_time_off', id, { providerId: current.provider_id });
      return this.toTimeOff({ ...current, active: false });
    });
  }

  private toTimeOff(row: { id: string; provider_id: string; starts_at: Date; ends_at: Date; reason: string; active: boolean }): ProviderTimeOff {
    return { id: row.id, providerId: row.provider_id, startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), reason: row.reason, active: row.active };
  }

  private async requireProvider(trx: Kysely<Database>, id: string): Promise<void> {
    const row = await trx.selectFrom('providers').select('id').where('id', '=', id).executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Provider not found');
    }
  }

  // ------------------------------------------------------------- availability

  /**
   * The open start times for one kind of visit, earliest first. Computed by the same code
   * the AI receptionist will use, so staff can check what callers would be offered.
   */
  availability(auth: AuthContext, query: AvailabilityQuery): Promise<AvailabilityResponse> {
    const now = new Date();
    const from = query.from ? new Date(query.from) : now;
    const to = query.to ? new Date(query.to) : new Date(from.getTime() + DEFAULT_SEARCH_DAYS * DAY);
    if (!(to.getTime() > from.getTime())) {
      throw new BadRequestException('"to" must be after "from"');
    }
    if (to.getTime() - from.getTime() > AVAILABILITY_WINDOW_MAX_DAYS * DAY) {
      throw new BadRequestException(`Search at most ${AVAILABILITY_WINDOW_MAX_DAYS} days at a time`);
    }

    return this.tenant.run(auth, (trx) =>
      this.findSlots(trx, auth.practiceId, {
        appointmentTypeId: query.appointmentTypeId,
        providerId: query.providerId,
        from,
        to,
        limit: query.limit ?? AVAILABILITY_LIMIT_DEFAULT,
        now,
      }),
    );
  }

  /**
   * The open start times for one kind of visit under the practice's rules for callers, earliest first.
   * Inside any practice-scoped transaction: the staff endpoint above and the AI receptionist's tool both
   * use it, so what staff see is exactly what a caller would be offered.
   */
  async findSlots(
    trx: Trx,
    practiceId: string,
    search: { appointmentTypeId: string; providerId?: string | undefined; from: Date; to: Date; limit: number; now: Date },
  ): Promise<AvailabilityResponse> {
    const { from, to, now } = search;
    const practice = await trx.selectFrom('practices').select('timezone').where('id', '=', practiceId).executeTakeFirstOrThrow();
    const type = await trx.selectFrom('appointment_types').selectAll().where('id', '=', search.appointmentTypeId).where('active', '=', true).executeTakeFirst();
    if (!type) {
      throw new NotFoundException('Appointment type not found');
    }
    let providersQuery = trx
      .selectFrom('providers as p')
      .innerJoin('provider_appointment_types as link', 'link.provider_id', 'p.id')
      .select(['p.id', 'p.name', 'p.hours'])
      .where('link.appointment_type_id', '=', type.id)
      .where('p.active', '=', true)
      .orderBy('p.name')
      .orderBy('p.id');
    if (search.providerId) providersQuery = providersQuery.where('p.id', '=', search.providerId);
    const providers = await providersQuery.execute();
    if (search.providerId && providers.length === 0) {
      throw new NotFoundException('That provider does not offer this appointment type');
    }

    const settings = await this.loadSettings(trx, practiceId);
    const providerIds = providers.map((provider) => provider.id);
    const timeOffRows =
      providerIds.length === 0
        ? []
        : await trx.selectFrom('provider_time_off').select(['provider_id', 'starts_at', 'ends_at']).where('provider_id', 'in', providerIds).where('active', '=', true).where('ends_at', '>', from).where('starts_at', '<', to).execute();

    // A slot that starts before `to` can run past it, so look for taken times a whole visit beyond the end.
    const busy = await loadBusy(trx, providerIds, from, new Date(to.getTime() + type.duration_minutes * MINUTE));
    const schedules: ProviderSchedule[] = providers.map((provider) => ({
      id: provider.id,
      hours: normalizeBusinessHours(provider.hours),
      timeOff: timeOffRows.filter((row) => row.provider_id === provider.id).map((row): Interval => ({ startsAt: row.starts_at, endsAt: row.ends_at })),
      busy: busy.get(provider.id) ?? [],
    }));
    const slots = computeSlotsForProviders(schedules, {
      timeZone: practice.timezone,
      rules: { slotMinutes: settings.slotMinutes, minNoticeHours: settings.minNoticeHours, maxAdvanceDays: settings.maxAdvanceDays },
      durationMinutes: type.duration_minutes,
      from,
      to,
      now,
      limit: search.limit,
    });
    const names = new Map(providers.map((provider) => [provider.id, provider.name]));
    return {
      timezone: practice.timezone,
      slots: slots.map((slot) => ({
        providerId: slot.providerId,
        providerName: names.get(slot.providerId) ?? '',
        appointmentTypeId: type.id,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
      })),
    };
  }

  // ------------------------------------------------------------------ helpers

  private audit(trx: Trx, auth: AuthContext, meta: RequestMeta, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
    return writeAuditLog(trx, {
      practiceId: auth.practiceId,
      actorUserId: auth.userId,
      action,
      targetType,
      targetId,
      requestId: meta.requestId,
      ip: meta.ip,
      metadata,
    });
  }
}
