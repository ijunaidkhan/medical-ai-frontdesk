import { Controller, Get, Query } from '@nestjs/common';
import type { AuditLogPage } from '@frontdesk/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { AuditQuery } from './audit.dto.js';
import { AuditService } from './audit.service.js';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermissions('audit:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: AuditQuery): Promise<AuditLogPage> {
    return this.audit.list(auth, query);
  }
}
