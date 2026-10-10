import { Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { StartWebCallResponse } from '@frontdesk/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { VoiceService } from './voice.service.js';

/** Each call can cost many model calls, so web-phone calls are limited per IP like test chats. */
const WEB_CALL_RATE_LIMIT = { ttl: 60_000, limit: 30 };

/** The web phone: talking to the practice's own receptionist from the browser. Development only (VOICE_PROVIDER=dev). */
@Controller('voice/web-calls')
export class WebCallsController {
  constructor(private readonly voice: VoiceService) {}

  @RequirePermissions('ai:configure')
  @Throttle({ default: WEB_CALL_RATE_LIMIT })
  @Post()
  start(@CurrentAuth() auth: AuthContext, @Req() request: Request): Promise<StartWebCallResponse> {
    return this.voice.startWebCall(auth, requestMeta(request));
  }
}
