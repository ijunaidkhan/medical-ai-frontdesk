import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from './auth-context.js';

/**
 * The verified identity of the request (user, practice, role, session), as
 * established by AccessTokenGuard. Use this instead of reading ids from the
 * request body or URL when deciding which tenant to act in.
 */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const auth = context.switchToHttp().getRequest<Request>().auth;
  if (!auth) {
    // Only reachable if a route is marked @Public() yet asks for an identity.
    throw new UnauthorizedException();
  }
  return auth;
});
