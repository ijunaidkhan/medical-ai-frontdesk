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
  'calls:read',
  'schedule:read',
  'schedule:manage',
  'schedule:configure',
  'patients:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Typed as a full Record so adding a role without deciding its permissions
 * is a compile error. Finer limits (for example, admins cannot change owners)
 * are business rules in the API, not extra permissions.
 *
 * Staff work the task queue (callback and message requests) and book appointments
 * for callers, so they hold tasks:manage and schedule:manage; the other ":manage"
 * and every ":configure" permission stay with owners and admins (who sets up the
 * providers, appointment types and booking rules).
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  staff: [
    'practice:read',
    'members:read',
    'knowledge:read',
    'tasks:read',
    'tasks:manage',
    'ai:read',
    'calls:read',
    'schedule:read',
    'schedule:manage',
    'patients:read',
  ],
  viewer: ['practice:read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
