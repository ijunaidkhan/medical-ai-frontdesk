import { ROLES, type MemberStatus, type Role } from '@frontdesk/shared';
import { authorizeMemberChange } from './member-policy.js';

const ACTOR = '0190a1b2-c3d4-7e5f-8a9b-000000000001';
const OTHER = '0190a1b2-c3d4-7e5f-8a9b-000000000002';

function decide(
  actorRole: Role,
  targetRole: Role,
  change: { role?: Role; status?: MemberStatus },
  options: { targetStatus?: MemberStatus; self?: boolean } = {},
) {
  return authorizeMemberChange({
    actor: { userId: ACTOR, role: actorRole },
    target: { userId: options.self ? ACTOR : OTHER, role: targetRole, status: options.targetStatus ?? 'active' },
    change,
  });
}

describe('authorizeMemberChange', () => {
  describe('roles that cannot manage members at all', () => {
    it.each<Role>(['staff', 'viewer'])('refuses a %s whatever they ask for', (role) => {
      const decision = decide(role, 'viewer', { status: 'suspended' });
      expect(decision).toMatchObject({ allowed: false, reason: 'not_permitted' });
    });
  });

  describe('nobody changes themselves', () => {
    it.each<Role>(['owner', 'admin'])('refuses a %s changing their own role', (role) => {
      expect(decide(role, role, { role: 'viewer' }, { self: true })).toMatchObject({ allowed: false, reason: 'self' });
    });

    it.each<Role>(['owner', 'admin'])('refuses a %s suspending themselves', (role) => {
      expect(decide(role, role, { status: 'suspended' }, { self: true })).toMatchObject({ allowed: false, reason: 'self' });
    });

    it('refuses an admin promoting themselves to owner', () => {
      expect(decide('admin', 'admin', { role: 'owner' }, { self: true })).toMatchObject({ allowed: false, reason: 'self' });
    });
  });

  describe('changes that change nothing', () => {
    it.each([
      ['an empty request', {}],
      ['the role they already have', { role: 'staff' as Role }],
      ['the status they already have', { status: 'active' as MemberStatus }],
      ['both unchanged', { role: 'staff' as Role, status: 'active' as MemberStatus }],
    ])('are refused as "no change": %s', (_label, change) => {
      expect(decide('owner', 'staff', change)).toMatchObject({ allowed: false, reason: 'no_change' });
    });
  });

  describe('an owner', () => {
    it.each(ROLES)('may change a %s to any role', (targetRole) => {
      for (const newRole of ROLES.filter((r) => r !== targetRole)) {
        expect(decide('owner', targetRole, { role: newRole })).toEqual({ allowed: true });
      }
    });

    it.each(ROLES)('may suspend and reactivate a %s', (targetRole) => {
      expect(decide('owner', targetRole, { status: 'suspended' })).toEqual({ allowed: true });
      expect(decide('owner', targetRole, { status: 'active' }, { targetStatus: 'suspended' })).toEqual({ allowed: true });
    });
  });

  describe('an admin', () => {
    it.each<Role>(['staff', 'viewer'])('may manage a %s', (targetRole) => {
      expect(decide('admin', targetRole, { status: 'suspended' })).toEqual({ allowed: true });
      expect(decide('admin', targetRole, { role: targetRole === 'staff' ? 'viewer' : 'staff' })).toEqual({ allowed: true });
    });

    it.each<Role>(['owner', 'admin'])('may NOT touch a %s (lateral and upward changes are owner-only)', (targetRole) => {
      expect(decide('admin', targetRole, { status: 'suspended' })).toMatchObject({ allowed: false, reason: 'owner_only' });
      expect(decide('admin', targetRole, { role: 'viewer' })).toMatchObject({ allowed: false, reason: 'owner_only' });
    });

    it.each<Role>(['admin', 'owner'])('may NOT make anyone a %s (no privilege escalation)', (newRole) => {
      for (const targetRole of ['staff', 'viewer'] as const) {
        expect(decide('admin', targetRole, { role: newRole })).toMatchObject({ allowed: false, reason: 'owner_only' });
      }
    });

    it('may NOT slip an escalation in alongside a harmless status change', () => {
      expect(decide('admin', 'staff', { role: 'admin', status: 'suspended' })).toMatchObject({ allowed: false, reason: 'owner_only' });
    });
  });

  it('has a decision for every role pairing (no combination falls through)', () => {
    for (const actor of ROLES) {
      for (const target of ROLES) {
        for (const change of [{ role: 'viewer' as Role }, { status: 'suspended' as MemberStatus }]) {
          const decision = decide(actor, target, change);
          expect(typeof decision.allowed).toBe('boolean');
        }
      }
    }
  });
});
