import type { Role } from './roles.js';

/**
 * What a signed-in user may do inside their practice. The API enforces these;
 * the web app only uses them to hide controls that would be refused anyway.
 */
export const PERMISSIONS = [
  'practice:read',
  'practice:manage',
  'members:read',
  'members:manage',
  'audit:read',
  'knowledge:read',
  'knowledge:manage',
  'tasks:read',
  'tasks:manage',
  'ai:read',
  'ai:configure',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Typed as a full Record so adding a role without deciding its permissions
 * is a compile error. Finer limits (for example, admins cannot change owners)
 * are business rules in the API, not extra permissions.
 *
 * Staff work the task queue (callback and message requests), so they hold
 * tasks:manage; the other ":manage" permissions stay with owners and admins.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  staff: ['practice:read', 'members:read', 'knowledge:read', 'tasks:read', 'tasks:manage', 'ai:read'],
  viewer: ['practice:read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
