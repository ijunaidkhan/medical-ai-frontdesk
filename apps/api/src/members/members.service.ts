import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { MemberSummary } from '@frontdesk/shared';
import { sql } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../common/request-meta.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { authorizeMemberChange } from './member-policy.js';
import type { UpdateMemberDto } from './members.dto.js';

/** A practice is small; this is a safety cap, not pagination. */
const MEMBER_LIST_LIMIT = 500;

const CHECK_VIOLATION = '23514';

@Injectable()
export class MembersService {
  constructor(private readonly tenant: TenantDb) {}

  list(auth: AuthContext): Promise<MemberSummary[]> {
    return this.tenant.run(auth, async (trx) => {
      const rows = await trx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select([
          'memberships.user_id as userId',
          'users.email',
          'users.display_name as displayName',
          'memberships.role',
          'memberships.status',
          'memberships.created_at as joinedAt',
        ])
        .where('memberships.practice_id', '=', auth.practiceId)
        .orderBy('users.display_name')
        .orderBy('memberships.id')
        .limit(MEMBER_LIST_LIMIT)
        .execute();
      return rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }));
    });
  }

  async update(auth: AuthContext, targetUserId: string, dto: UpdateMemberDto, meta: RequestMeta): Promise<MemberSummary> {
    try {
      return await this.tenant.run(auth, async (trx) => {
        // Lock the row so two admins editing the same member are handled one at a time.
        const target = await trx
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select([
            'memberships.id as membershipId',
            'memberships.user_id as userId',
            'memberships.role',
            'memberships.status',
            'memberships.created_at as joinedAt',
            'users.email',
            'users.display_name as displayName',
          ])
          .where('memberships.practice_id', '=', auth.practiceId)
          .where('memberships.user_id', '=', targetUserId)
          .forUpdate('memberships')
          .executeTakeFirst();
        // Another practice's member is invisible here, so it is simply "not found".
        if (!target) {
          throw new NotFoundException('Member not found');
        }

        const decision = authorizeMemberChange({
          actor: { userId: auth.userId, role: auth.role },
          target: { userId: target.userId, role: target.role, status: target.status },
          change: { role: dto.role, status: dto.status },
        });
        if (!decision.allowed) {
          if (decision.reason === 'no_change') {
            throw new BadRequestException(decision.message);
          }
          throw new ForbiddenException(decision.message);
        }

        const roleChanged = dto.role !== undefined && dto.role !== target.role;
        const statusChanged = dto.status !== undefined && dto.status !== target.status;
        const updated = await trx
          .updateTable('memberships')
          .set({
            ...(roleChanged && { role: dto.role }),
            ...(statusChanged && { status: dto.status }),
          })
          .where('id', '=', target.membershipId)
          .returning(['role', 'status'])
          .executeTakeFirstOrThrow();

        // A new role, or a suspension, ends the member's sessions so they sign in afresh.
        if (roleChanged || dto.status === 'suspended') {
          await trx
            .updateTable('refresh_tokens')
            .set({ revoked_at: sql<Date>`now()` })
            .where('user_id', '=', target.userId)
            .where('practice_id', '=', auth.practiceId)
            .where('revoked_at', 'is', null)
            .execute();
        }

        const audit = (action: string, metadata: Record<string, unknown>) =>
          writeAuditLog(trx, {
            practiceId: auth.practiceId,
            actorUserId: auth.userId,
            action,
            targetType: 'user',
            targetId: target.userId,
            requestId: meta.requestId,
            ip: meta.ip,
            metadata,
          });
        if (roleChanged) {
          await audit('member.role_changed', { from: target.role, to: updated.role });
        }
        if (statusChanged) {
          await audit(updated.status === 'suspended' ? 'member.suspended' : 'member.reactivated', {});
        }

        return {
          userId: target.userId,
          email: target.email,
          displayName: target.displayName,
          role: updated.role,
          status: updated.status,
          joinedAt: target.joinedAt.toISOString(),
        };
      });
    } catch (error) {
      // The database refuses to leave a practice without an active owner.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === CHECK_VIOLATION) {
        throw new ConflictException('A practice must keep at least one active owner');
      }
      throw error;
    }
  }
}
