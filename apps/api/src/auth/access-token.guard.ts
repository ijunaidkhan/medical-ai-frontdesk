import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccessTokenService } from './access-token.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

/**
 * Registered globally: every route requires a valid access token unless it is
 * explicitly marked @Public(). On success the verified identity is available as
 * `request.auth` (see @CurrentAuth()).
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = BEARER_PATTERN.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    request.auth = await this.tokens.verify(token);
    return true;
  }
}
