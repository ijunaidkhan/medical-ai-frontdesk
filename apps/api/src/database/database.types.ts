import type { Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { Role } from '@frontdesk/shared';

// Hand-written to match apps/api/migrations. A migration that changes a table
// must update its interface here; the integration tests catch drift in the
// parts they exercise.

export interface PracticesTable {
  id: Generated<string>;
  name: string;
  slug: string;
  timezone: Generated<string>;
  phone: string | null;
  status: Generated<'active' | 'suspended'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  status: Generated<'active' | 'disabled'>;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MembershipsTable {
  id: Generated<string>;
  practice_id: string;
  user_id: string;
  role: Role;
  status: Generated<'active' | 'suspended'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  practice_id: string;
  family_id: string;
  token_hash: Buffer;
  expires_at: Date;
  session_expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: string | null;
  created_ip: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface AuditLogsTable {
  id: Generated<string>;
  practice_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  ip: string | null;
  metadata: Generated<Record<string, unknown>>;
  occurred_at: Generated<Date>;
}

export interface Database {
  practices: PracticesTable;
  users: UsersTable;
  memberships: MembershipsTable;
  refresh_tokens: RefreshTokensTable;
  audit_logs: AuditLogsTable;
}

export type Practice = Selectable<PracticesTable>;
export type NewPractice = Insertable<PracticesTable>;
export type PracticeUpdate = Updateable<PracticesTable>;
