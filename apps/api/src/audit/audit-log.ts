import type { AuditActorType } from '@frontdesk/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../database/database.types.js';

export interface AuditEntry {
  /** The tenant the event belongs to; null for events before a practice is known (e.g. a failed login). */
  practiceId: string | null;
  /** The person who acted. Always null for the AI receptionist and the system. */
  actorUserId: string | null;
  /** A person (default), the system, or the AI receptionist. */
  actorType?: AuditActorType;
  /** Dotted, lowercase event name, e.g. "auth.login.success". */
  action: string;
  targetType?: string;
  targetId?: string;
  requestId?: string | null;
  ip?: string | null;
  /**
   * Structured context. Must never contain passwords, tokens, or patient data.
   * Prefer identifiers and short reason codes.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Appends one row to the audit log. Pass a transaction to make the entry commit
 * or roll back together with the change it describes.
 */
export async function writeAuditLog(executor: Kysely<Database>, entry: AuditEntry): Promise<void> {
  await executor
    .insertInto('audit_logs')
    .values({
      practice_id: entry.practiceId,
      actor_user_id: entry.actorUserId,
      actor_type: entry.actorType ?? 'user',
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      request_id: entry.requestId ?? null,
      ip: entry.ip ?? null,
      metadata: entry.metadata ?? {},
    })
    .execute();
}
