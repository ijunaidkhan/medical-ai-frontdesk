export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

/** Who performed the action: a signed-in person, the system itself, or the AI receptionist. */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'ai'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditLogEntry {
  id: string;
  /** Dotted event name, e.g. "member.role_changed". */
  action: string;
  actorType: AuditActorType;
  actorUserId: string | null;
  /** The actor's name when they belong to this practice. */
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  requestId: string | null;
  /** Identifiers and reason codes only; never secrets or patient data. */
  metadata: Record<string, unknown>;
  occurredAt: string;
}

/** Newest first. Pass `nextCursor` back as `cursor` to get the following page. */
export interface AuditLogPage {
  items: AuditLogEntry[];
  nextCursor: string | null;
}
