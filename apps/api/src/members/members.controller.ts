import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { MemberSummary } from '@frontdesk/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { MemberParams, UpdateMemberDto } from './members.dto.js';
import { MembersService } from './members.service.js';

/** Members of the signed-in user's own practice. */
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @RequirePermissions('members:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<MemberSummary[]> {
    return this.members.list(auth);
  }

  @RequirePermissions('members:manage')
  @Patch(':userId')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param() params: MemberParams,
    @Body() dto: UpdateMemberDto,
    @Req() request: Request,
  ): Promise<MemberSummary> {
    return this.members.update(auth, params.userId, dto, requestMeta(request));
  }
}
