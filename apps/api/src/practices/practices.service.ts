import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PracticeDetails } from '@frontdesk/shared';
import type { Transaction } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import type { UpdatePracticeDto } from './practices.dto.js';

const COLUMNS = ['id', 'name', 'slug', 'timezone', 'phone', 'status', 'created_at'] as const;

function toDetails(row: {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  phone: string | null;
  status: 'active' | 'suspended';
  created_at: Date;
}): PracticeDetails {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    phone: row.phone,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class PracticesService {
  constructor(private readonly tenant: TenantDb) {}

  get(auth: AuthContext): Promise<PracticeDetails> {
    return this.tenant.run(auth, async (trx) => toDetails(await this.load(trx, auth.practiceId)));
  }

  async update(auth: AuthContext, dto: UpdatePracticeDto, meta: RequestMeta): Promise<PracticeDetails> {
    const changes: { name?: string; timezone?: string; phone?: string | null } = {};
    if (dto.name !== undefined) changes.name = dto.name;
    if (dto.timezone !== undefined) changes.timezone = dto.timezone;
    if (dto.phone !== undefined) changes.phone = dto.phone;
    const fields = Object.keys(changes);
    if (fields.length === 0) {
      throw new BadRequestException('Nothing to change');
    }

    return this.tenant.run(auth, async (trx) => {
      const row = await trx
        .updateTable('practices')
        .set(changes)
        .where('id', '=', auth.practiceId)
        .returning(COLUMNS)
        .executeTakeFirst();
      if (!row) {
        throw new NotFoundException('Practice not found');
      }
      await writeAuditLog(trx, {
        practiceId: auth.practiceId,
        actorUserId: auth.userId,
        action: 'practice.updated',
        targetType: 'practice',
        targetId: auth.practiceId,
        requestId: meta.requestId,
        ip: meta.ip,
        // Field names only: enough to see what changed and by whom.
        metadata: { fields },
      });
      return toDetails(row);
    });
  }

  private async load(trx: Transaction<Database>, practiceId: string) {
    const row = await trx.selectFrom('practices').select(COLUMNS).where('id', '=', practiceId).executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Practice not found');
    }
    return row;
  }
}
