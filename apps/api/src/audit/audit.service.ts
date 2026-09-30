import { BadRequestException, Injectable } from '@nestjs/common';
import { AUDIT_PAGE_DEFAULT, type AuditActorType, type AuditLogPage } from '@frontdesk/shared';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor.js';
import type { AuditQuery } from './audit.dto.js';

interface AuditRow {
  id: string;
  action: string;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  actor_name: string | null;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  occurred_at_text: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly tenant: TenantDb) {}

  /** The signed-in practice's audit trail, newest first. Row-level security hides every other practice. */
  async list(auth: AuthContext, query: AuditQuery): Promise<AuditLogPage> {
    const limit = query.limit ?? AUDIT_PAGE_DEFAULT;
    const cursor = query.cursor === undefined ? null : decodeAuditCursor(query.cursor);
    if (query.cursor !== undefined && !cursor) {
      throw new BadRequestException('Invalid cursor');
    }

    const rows = await this.tenant.run(auth, async (trx) => {
      const after = cursor ? sql`where (a.occurred_at, a.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``;
      const result = await sql<AuditRow>`
        select a.id,
               a.action,
               a.actor_type,
               a.actor_user_id,
               u.display_name as actor_name,
               a.target_type,
               a.target_id,
               host(a.ip) as ip,
               a.request_id,
               a.metadata,
               a.occurred_at,
               a.occurred_at::text as occurred_at_text
        from audit_logs a
        left join users u on u.id = a.actor_user_id
        ${after}
        order by a.occurred_at desc, a.id desc
        limit ${limit + 1}`.execute(trx);
      return result.rows;
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        action: row.action,
        actorType: row.actor_type,
        actorUserId: row.actor_user_id,
        actorName: row.actor_name,
        targetType: row.target_type,
        targetId: row.target_id,
        ip: row.ip,
        requestId: row.request_id,
        metadata: row.metadata,
        occurredAt: row.occurred_at.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeAuditCursor({ at: last.occurred_at_text, id: last.id }) : null,
    };
  }
}
