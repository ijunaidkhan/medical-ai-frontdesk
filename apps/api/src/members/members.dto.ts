import { MEMBER_STATUSES, type MemberStatus, ROLES, type Role, type UpdateMemberRequest } from '@frontdesk/shared';
import { IsIn, IsUUID, ValidateIf } from 'class-validator';

const provided = (_: unknown, value: unknown) => value !== undefined;

export class MemberParams {
  @IsUUID()
  userId!: string;
}

export class UpdateMemberDto implements UpdateMemberRequest {
  @ValidateIf(provided)
  @IsIn(ROLES)
  role?: Role;

  @ValidateIf(provided)
  @IsIn(MEMBER_STATUSES)
  status?: MemberStatus;
}
