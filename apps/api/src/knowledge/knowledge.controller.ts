import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { KnowledgeSearchResult, KnowledgeSourceDetail, KnowledgeSourceSummary } from '@frontdesk/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { CreateKnowledgeDto, KnowledgeParams, KnowledgeSearchQuery, UpdateKnowledgeDto } from './knowledge.dto.js';
import { KnowledgeService } from './knowledge.service.js';

/** The signed-in practice's knowledge base. There is no way to name another practice. */
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @RequirePermissions('knowledge:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<KnowledgeSourceSummary[]> {
    return this.knowledge.list(auth);
  }

  /** Declared before ':id' so "search" is never mistaken for an id. */
  @RequirePermissions('knowledge:read')
  @Get('search')
  search(@CurrentAuth() auth: AuthContext, @Query() query: KnowledgeSearchQuery): Promise<KnowledgeSearchResult[]> {
    return this.knowledge.search(auth, query.q);
  }

  @RequirePermissions('knowledge:read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() params: KnowledgeParams): Promise<KnowledgeSourceDetail> {
    return this.knowledge.get(auth, params.id);
  }

  @RequirePermissions('knowledge:manage')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateKnowledgeDto, @Req() request: Request): Promise<KnowledgeSourceDetail> {
    return this.knowledge.create(auth, dto, requestMeta(request));
  }

  @RequirePermissions('knowledge:manage')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param() params: KnowledgeParams,
    @Body() dto: UpdateKnowledgeDto,
    @Req() request: Request,
  ): Promise<KnowledgeSourceDetail> {
    return this.knowledge.update(auth, params.id, dto, requestMeta(request));
  }

  @RequirePermissions('knowledge:manage')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentAuth() auth: AuthContext, @Param() params: KnowledgeParams, @Req() request: Request): Promise<KnowledgeSourceDetail> {
    return this.knowledge.approve(auth, params.id, requestMeta(request));
  }

  @RequirePermissions('knowledge:manage')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentAuth() auth: AuthContext, @Param() params: KnowledgeParams, @Req() request: Request): Promise<KnowledgeSourceDetail> {
    return this.knowledge.archive(auth, params.id, requestMeta(request));
  }

  @RequirePermissions('knowledge:manage')
  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentAuth() auth: AuthContext, @Param() params: KnowledgeParams, @Req() request: Request): Promise<KnowledgeSourceDetail> {
    return this.knowledge.restore(auth, params.id, requestMeta(request));
  }
}
