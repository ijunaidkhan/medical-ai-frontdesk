import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { EnvironmentVariables } from '../config/env.validation.js';

/**
 * CSRF defence for the two routes authenticated by the refresh cookie
 * (refresh and logout). A browser attaches the cookie to any request from any
 * site, so these routes also require an Origin header that names our own web
 * app. Browsers always send Origin on such POSTs and scripts cannot forge it.
 * (The cookie is also SameSite=Strict; this is the second layer.)
 *
 * Allowed: an origin in CORS_ORIGINS, or one whose host is this API's own host
 * (when the web app is served from the same address).
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.allowedOrigins = new Set(config.get('CORS_ORIGINS', { infer: true }));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!isAllowedOrigin(request.headers.origin, request.headers.host, this.allowedOrigins)) {
      throw new ForbiddenException('Request origin not allowed');
    }
    return true;
  }
}

export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (typeof origin !== 'string' || origin.length === 0) {
    return false;
  }
  if (allowed.has(origin)) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && host !== undefined && url.host === host;
  } catch {
    return false; // includes the literal "null" origin sent by sandboxed pages
  }
}
