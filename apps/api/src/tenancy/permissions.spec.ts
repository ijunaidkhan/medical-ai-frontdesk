import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from '@frontdesk/shared';

describe('role permissions', () => {
  it('defines permissions for every role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it('only grants permissions that exist', () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it.each<[Role, Permission[], Permission[]]>([
    ['owner', [...PERMISSIONS], []],
    ['admin', [...PERMISSIONS], []],
    [
      'staff',
      ['practice:read', 'members:read', 'knowledge:read', 'tasks:read', 'tasks:manage'],
      ['practice:manage', 'members:manage', 'audit:read', 'knowledge:manage'],
    ],
    [
      'viewer',
      ['practice:read'],
      ['practice:manage', 'members:read', 'members:manage', 'audit:read', 'knowledge:read', 'knowledge:manage', 'tasks:read', 'tasks:manage'],
    ],
  ])('%s has exactly the intended permissions', (role, allowed, denied) => {
    for (const permission of allowed) expect(hasPermission(role, permission)).toBe(true);
    for (const permission of denied) expect(hasPermission(role, permission)).toBe(false);
    // "Exactly": nothing beyond the allowed list, and every permission is decided one way or the other.
    expect([...allowed, ...denied].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('never gives a lower role something a higher role lacks', () => {
    const rank: Role[] = ['viewer', 'staff', 'admin', 'owner'];
    for (let i = 0; i < rank.length - 1; i++) {
      for (const permission of ROLE_PERMISSIONS[rank[i]!]) {
        expect(hasPermission(rank[i + 1]!, permission)).toBe(true);
      }
    }
  });

  it('keeps every write and audit permission away from viewers', () => {
    expect(ROLE_PERMISSIONS.viewer.filter((p) => p.endsWith(':manage') || p.startsWith('audit:'))).toEqual([]);
  });

  it('keeps every write and audit permission away from staff EXCEPT working the task queue', () => {
    // Staff answer the phones and work callbacks, so tasks:manage is deliberate; nothing else is.
    const writes = ROLE_PERMISSIONS.staff.filter((p) => p.endsWith(':manage') || p.startsWith('audit:'));
    expect(writes).toEqual(['tasks:manage']);
  });
});
