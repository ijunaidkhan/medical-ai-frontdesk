import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import type { PracticeDetails } from '@frontdesk/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { UpdatePracticeDto } from './practices.dto.js';
import { PracticesService } from './practices.service.js';

/** The signed-in user's own practice. There is no way to name a different one. */
@Controller('practice')
export class PracticesController {
  constructor(private readonly practices: PracticesService) {}

  @RequirePermissions('practice:read')
  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<PracticeDetails> {
    return this.practices.get(auth);
  }

  @RequirePermissions('practice:manage')
  @Patch()
  update(@CurrentAuth() auth: AuthContext, @Body() dto: UpdatePracticeDto, @Req() request: Request): Promise<PracticeDetails> {
    return this.practices.update(auth, dto, requestMeta(request));
  }
}
