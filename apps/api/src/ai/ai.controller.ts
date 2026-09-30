import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { AiSettings, TransferTarget } from '@frontdesk/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { CreateTransferTargetDto, TransferTargetParams, UpdateAiSettingsDto, UpdateTransferTargetDto } from './ai.dto.js';
import { AiService } from './ai.service.js';

/** How the signed-in practice's AI receptionist is set up. There is no way to name another practice. */
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @RequirePermissions('ai:read')
  @Get('settings')
  settings(@CurrentAuth() auth: AuthContext): Promise<AiSettings> {
    return this.ai.getSettings(auth);
  }

  @RequirePermissions('ai:configure')
  @Patch('settings')
  updateSettings(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateAiSettingsDto, @Req() request: Request): Promise<AiSettings> {
    return this.ai.updateSettings(auth, dto, requestMeta(request));
  }

  @RequirePermissions('ai:read')
  @Get('transfer-targets')
  transferTargets(@CurrentAuth() auth: AuthContext): Promise<TransferTarget[]> {
    return this.ai.listTransferTargets(auth);
  }

  @RequirePermissions('ai:configure')
  @Post('transfer-targets')
  createTransferTarget(@CurrentAuth() auth: AuthContext, @Body() dto: CreateTransferTargetDto, @Req() request: Request): Promise<TransferTarget> {
    return this.ai.createTransferTarget(auth, dto, requestMeta(request));
  }

  @RequirePermissions('ai:configure')
  @Patch('transfer-targets/:id')
  updateTransferTarget(
    @CurrentAuth() auth: AuthContext,
    @Param() params: TransferTargetParams,
    @Body() dto: UpdateTransferTargetDto,
    @Req() request: Request,
  ): Promise<TransferTarget> {
    return this.ai.updateTransferTarget(auth, params.id, dto, requestMeta(request));
  }
}
