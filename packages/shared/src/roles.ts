/** Roles a user can hold within a single practice (the tenant). */
export const ROLES = ['owner', 'admin', 'staff', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
