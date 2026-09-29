import { hasPermission, type MemberStatus, type Role } from '@frontdesk/shared';

export interface MemberChangeInput {
  /** The person making the change, with their CURRENT role. */
  actor: { userId: string; role: Role };
  /** The member being changed, as they are now. */
  target: { userId: string; role: Role; status: MemberStatus };
  /** What the request asks for. Absent fields are left alone. */
  change: { role?: Role; status?: MemberStatus };
}

export type MemberChangeDecision =
  | { allowed: true }
  | { allowed: false; reason: 'not_permitted' | 'self' | 'no_change' | 'owner_only'; message: string };

const ADMIN_MANAGEABLE: readonly Role[] = ['staff', 'viewer'];

/**
 * Who may change whose role or status. These rules prevent privilege escalation:
 *
 *  - Nobody changes their own role or status (no self-promotion, no lockout).
 *  - An owner may change anyone else in the practice.
 *  - An admin may only manage staff and viewers, and may only make someone a
 *    staff member or a viewer. Only owners create or change admins and owners.
 *
 * "A practice always keeps an owner" is enforced separately, by the database.
 */
export function authorizeMemberChange({ actor, target, change }: MemberChangeInput): MemberChangeDecision {
  if (!hasPermission(actor.role, 'members:manage')) {
    return { allowed: false, reason: 'not_permitted', message: 'You do not have permission to manage members' };
  }
  if (actor.userId === target.userId) {
    return { allowed: false, reason: 'self', message: 'You cannot change your own role or status' };
  }

  const roleChanges = change.role !== undefined && change.role !== target.role;
  const statusChanges = change.status !== undefined && change.status !== target.status;
  if (!roleChanges && !statusChanges) {
    return { allowed: false, reason: 'no_change', message: 'Nothing to change' };
  }

  if (actor.role === 'owner') {
    return { allowed: true };
  }

  const targetIsManageable = ADMIN_MANAGEABLE.includes(target.role);
  const newRoleIsAllowed = change.role === undefined || ADMIN_MANAGEABLE.includes(change.role);
  if (!targetIsManageable || !newRoleIsAllowed) {
    return {
      allowed: false,
      reason: 'owner_only',
      message: 'Only an owner can change owners or administrators, or make someone an administrator or owner',
    };
  }
  return { allowed: true };
}
