import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  aiReadinessProblems,
  emptyBusinessHours,
  normalizeBusinessHours,
  type AiConfiguration,
  type AiSettings,
  type TransferTarget,
} from '@frontdesk/shared';
import type { Kysely, Transaction } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import type { CreateTransferTargetDto, UpdateAiSettingsDto, UpdateTransferTargetDto } from './ai.dto.js';

const UNIQUE_VIOLATION = '23505';

/** The settings a practice starts with: everything off, nothing written. */
type State = AiConfiguration & Pick<AiSettings, 'enabled' | 'extraUrgentPhrases'>;

const DEFAULT_STATE: State = {
  enabled: false,
  greeting: '',
  afterHoursAction: 'take_message',
  afterHoursTransferTargetId: null,
  emergencyMessage: '',
  crisisMessage: '',
  urgentAction: 'urgent_task',
  urgentTransferTargetId: null,
  extraUrgentPhrases: [],
  businessHours: emptyBusinessHours(),
};

/** Drops repeats, ignoring capital letters, keeping the first spelling. */
function uniquePhrases(phrases: readonly string[]): string[] {
  const seen = new Set<string>();
  return phrases.filter((phrase) => {
    const key = phrase.toLowerCase();
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === UNIQUE_VIOLATION;
}

@Injectable()
export class AiService {
  constructor(private readonly tenant: TenantDb) {}

  // ------------------------------------------------------------- settings

  getSettings(auth: AuthContext): Promise<AiSettings> {
    return this.tenant.run(auth, async (trx) => {
      const [row, targets] = await Promise.all([this.loadRow(trx, auth.practiceId), this.listTargets(trx)]);
      return this.describe(row?.state ?? DEFAULT_STATE, row?.updatedAt ?? null, targets);
    });
  }

  updateSettings(auth: AuthContext, dto: UpdateAiSettingsDto, meta: RequestMeta): Promise<AiSettings> {
    return this.tenant.run(auth, async (trx) => {
      const targets = await this.listTargets(trx);
      const existing = await this.loadRow(trx, auth.practiceId, true);
      const current = existing?.state ?? DEFAULT_STATE;

      const next: State = { ...current };
      if (dto.enabled !== undefined) next.enabled = dto.enabled;
      if (dto.greeting !== undefined) next.greeting = dto.greeting;
      if (dto.afterHoursAction !== undefined) next.afterHoursAction = dto.afterHoursAction;
      if (dto.afterHoursTransferTargetId !== undefined) next.afterHoursTransferTargetId = dto.afterHoursTransferTargetId;
      if (dto.emergencyMessage !== undefined) next.emergencyMessage = dto.emergencyMessage;
      if (dto.crisisMessage !== undefined) next.crisisMessage = dto.crisisMessage;
      if (dto.urgentAction !== undefined) next.urgentAction = dto.urgentAction;
      if (dto.urgentTransferTargetId !== undefined) next.urgentTransferTargetId = dto.urgentTransferTargetId;
      if (dto.extraUrgentPhrases !== undefined) next.extraUrgentPhrases = uniquePhrases(dto.extraUrgentPhrases);
      if (dto.businessHours !== undefined) next.businessHours = normalizeBusinessHours(dto.businessHours);

      // Only numbers that exist here and are active may be chosen.
      for (const id of [dto.afterHoursTransferTargetId, dto.urgentTransferTargetId]) {
        if (id && !targets.some((target) => target.id === id && target.active)) {
          throw new BadRequestException('That transfer number does not exist or is not active');
        }
      }

      const changed = (Object.keys(next) as Array<keyof State>).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
      if (changed.length === 0) {
        throw new BadRequestException('Nothing to change');
      }

      // The AI may only be ON when everything it needs is in place. Turning it off is always allowed.
      if (next.enabled) {
        const problems = aiReadinessProblems(next, targets);
        if (problems.length > 0) {
          throw new ConflictException(problems);
        }
      }

      const columns = {
        enabled: next.enabled,
        greeting: next.greeting,
        after_hours_action: next.afterHoursAction,
        after_hours_transfer_target_id: next.afterHoursTransferTargetId,
        emergency_message: next.emergencyMessage,
        crisis_message: next.crisisMessage,
        urgent_action: next.urgentAction,
        urgent_transfer_target_id: next.urgentTransferTargetId,
        extra_urgent_phrases: next.extraUrgentPhrases,
        business_hours: next.businessHours,
        updated_by: auth.userId,
      };
      await trx
        .insertInto('ai_settings')
        .values({ practice_id: auth.practiceId, ...columns })
        .onConflict((conflict) => conflict.column('practice_id').doUpdateSet(columns))
        .execute();

      const audit = (action: string, metadata: Record<string, unknown>) =>
        writeAuditLog(trx, {
          practiceId: auth.practiceId,
          actorUserId: auth.userId,
          action,
          targetType: 'ai_settings',
          targetId: auth.practiceId,
          requestId: meta.requestId,
          ip: meta.ip,
          metadata,
        });
      const fields = changed.filter((key) => key !== 'enabled');
      if (fields.length > 0) await audit('ai.settings_updated', { fields }); // field names only, never the wording
      if (changed.includes('enabled')) await audit(next.enabled ? 'ai.enabled' : 'ai.disabled', {});

      const saved = await this.loadRow(trx, auth.practiceId);
      return this.describe(saved?.state ?? next, saved?.updatedAt ?? null, targets);
    });
  }

  /**
   * The settings as the agent reads them, inside a practice-scoped transaction
   * the caller already holds. A practice that never saved settings gets the
   * all-off defaults, so the agent sees "nothing written" rather than an error.
   */
  async loadForAgent(trx: Transaction<Database>, practiceId: string): Promise<{ settings: State; targets: TransferTarget[] }> {
    const [row, targets] = await Promise.all([this.loadRow(trx, practiceId), this.listTargets(trx)]);
    return { settings: row?.state ?? DEFAULT_STATE, targets };
  }

  // ------------------------------------------------------ transfer numbers

  listTransferTargets(auth: AuthContext): Promise<TransferTarget[]> {
    return this.tenant.run(auth, (trx) => this.listTargets(trx));
  }

  async createTransferTarget(auth: AuthContext, dto: CreateTransferTargetDto, meta: RequestMeta): Promise<TransferTarget> {
    try {
      return await this.tenant.run(auth, async (trx) => {
        const row = await trx
          .insertInto('transfer_targets')
          .values({ practice_id: auth.practiceId, label: dto.label, phone: dto.phone, purpose: dto.purpose })
          .returning(['id', 'label', 'phone', 'purpose', 'active'])
          .executeTakeFirstOrThrow();
        await this.auditTarget(trx, auth, meta, 'ai.transfer_target_created', row.id, { purpose: dto.purpose });
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('A transfer number with that phone number already exists');
      throw error;
    }
  }

  async updateTransferTarget(auth: AuthContext, id: string, dto: UpdateTransferTargetDto, meta: RequestMeta): Promise<TransferTarget> {
    try {
      return await this.tenant.run(auth, async (trx) => {
        const current = await trx.selectFrom('transfer_targets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) {
          throw new NotFoundException('Transfer number not found');
        }
        const changes: Partial<Pick<TransferTarget, 'label' | 'phone' | 'purpose' | 'active'>> = {};
        for (const field of ['label', 'phone', 'purpose', 'active'] as const) {
          if (dto[field] !== undefined && dto[field] !== current[field]) {
            (changes as Record<string, unknown>)[field] = dto[field];
          }
        }
        const fields = Object.keys(changes);
        if (fields.length === 0) {
          throw new BadRequestException('Nothing to change');
        }

        if (changes.active === false) {
          const inUse = await trx
            .selectFrom('ai_settings')
            .select('practice_id')
            .where((eb) => eb.or([eb('after_hours_transfer_target_id', '=', id), eb('urgent_transfer_target_id', '=', id)]))
            .executeTakeFirst();
          if (inUse) {
            throw new ConflictException('The AI settings still use this number. Choose another one there first.');
          }
        }

        await trx.updateTable('transfer_targets').set(changes).where('id', '=', id).execute();
        await this.auditTarget(trx, auth, meta, 'ai.transfer_target_updated', id, { fields });
        return trx.selectFrom('transfer_targets').select(['id', 'label', 'phone', 'purpose', 'active']).where('id', '=', id).executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('A transfer number with that phone number already exists');
      throw error;
    }
  }

  // ---------------------------------------------------------------- helpers

  private describe(state: State, updatedAt: string | null, targets: readonly TransferTarget[]): AiSettings {
    const problems = aiReadinessProblems(state, targets);
    return { ...state, updatedAt, ready: problems.length === 0, problems };
  }

  private async loadRow(trx: Kysely<Database>, practiceId: string, lock = false): Promise<{ state: State; updatedAt: string } | null> {
    let query = trx.selectFrom('ai_settings').selectAll().where('practice_id', '=', practiceId);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) {
      return null;
    }
    return {
      updatedAt: row.updated_at.toISOString(),
      state: {
        enabled: row.enabled,
        greeting: row.greeting,
        afterHoursAction: row.after_hours_action,
        afterHoursTransferTargetId: row.after_hours_transfer_target_id,
        emergencyMessage: row.emergency_message,
        crisisMessage: row.crisis_message,
        urgentAction: row.urgent_action,
        urgentTransferTargetId: row.urgent_transfer_target_id,
        extraUrgentPhrases: row.extra_urgent_phrases,
        businessHours: normalizeBusinessHours(row.business_hours),
      },
    };
  }

  private listTargets(trx: Kysely<Database>): Promise<TransferTarget[]> {
    return trx
      .selectFrom('transfer_targets')
      .select(['id', 'label', 'phone', 'purpose', 'active'])
      .orderBy('active', 'desc')
      .orderBy('label')
      .orderBy('id')
      .execute();
  }

  private auditTarget(
    trx: Transaction<Database>,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return writeAuditLog(trx, {
      practiceId: auth.practiceId,
      actorUserId: auth.userId,
      action,
      targetType: 'transfer_target',
      targetId,
      requestId: meta.requestId,
      ip: meta.ip,
      metadata,
    });
  }
}
