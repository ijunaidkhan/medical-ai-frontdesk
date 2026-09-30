import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AgentReply, ConversationDetail, ConversationPage, StartConversationResponse } from '@frontdesk/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { ConversationListQuery, ConversationParams, SendMessageDto } from './agent.dto.js';
import { AgentService } from './agent.service.js';
import { ConversationsService } from './conversations.service.js';

/** Each message can cost a model call, so test chats are limited per IP on top of the general limit. */
const TEST_CHAT_RATE_LIMIT = { ttl: 60_000, limit: 30 };

/** A text "test chat" with the practice's own receptionist. The practice is always the signed-in one. */
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @RequirePermissions('ai:configure')
  @Throttle({ default: TEST_CHAT_RATE_LIMIT })
  @Post('test-conversations')
  start(@CurrentAuth() auth: AuthContext, @Req() request: Request): Promise<StartConversationResponse> {
    return this.agent.startTestConversation(auth, requestMeta(request));
  }

  @RequirePermissions('ai:configure')
  @Throttle({ default: TEST_CHAT_RATE_LIMIT })
  @HttpCode(200)
  @Post('test-conversations/:id/messages')
  send(@CurrentAuth() auth: AuthContext, @Param() params: ConversationParams, @Body() dto: SendMessageDto, @Req() request: Request): Promise<AgentReply> {
    return this.agent.sendMessage(auth, params.id, dto.text, requestMeta(request));
  }
}

/** Reviewing what the receptionist said and did. */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @RequirePermissions('calls:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ConversationListQuery): Promise<ConversationPage> {
    return this.conversations.list(auth, query);
  }

  @RequirePermissions('calls:read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() params: ConversationParams, @Req() request: Request): Promise<ConversationDetail> {
    return this.conversations.get(auth, params.id, requestMeta(request));
  }
}
