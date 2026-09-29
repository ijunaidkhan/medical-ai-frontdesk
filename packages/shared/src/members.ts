import type { Role } from './roles.js';

export const MEMBER_STATUSES = ['active', 'suspended'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface MemberSummary {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: MemberStatus;
  joinedAt: string;
}

/** Only the fields present are changed. */
export interface UpdateMemberRequest {
  role?: Role;
  status?: MemberStatus;
}
