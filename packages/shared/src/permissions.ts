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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Typed as a full Record so adding a role without deciding its permissions
 * is a compile error. Finer limits (for example, admins cannot change owners)
 * are business rules in the API, not extra permissions.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  staff: ['practice:read', 'members:read'],
  viewer: ['practice:read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
