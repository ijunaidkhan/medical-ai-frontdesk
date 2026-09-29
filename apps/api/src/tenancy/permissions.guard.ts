import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission, type Permission } from '@frontdesk/shared';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ActorVerifier } from './actor-verifier.js';
import { AUTHENTICATED_KEY, PERMISSIONS_KEY } from './permissions.decorator.js';

/**
 * Registered globally, after AccessTokenGuard. For every route that is not
 * @Public() it:
 *   1. refuses routes that declare no access rule (fail closed),
 *   2. confirms in the database that the user still has access and reads their
 *      CURRENT role (so removal, suspension, demotion and logout take effect
 *      immediately, not when the access token expires),
 *   3. checks the route's required permissions against that current role.
 * Downstream code reads the verified role from `request.auth`.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: ActorVerifier,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PermissionsGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;
    if (!auth) {
      throw new UnauthorizedException();
    }

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    const anySignedIn = this.reflector.getAllAndOverride<boolean | undefined>(AUTHENTICATED_KEY, targets);
    if (!required?.length && !anySignedIn) {
      this.logger.error(
        { method: request.method, path: request.path },
        'Route has no access rule (@RequirePermissions, @Authenticated or @Public); refusing it',
      );
      throw new ForbiddenException('This route has no access rule');
    }

    const actor = await this.verifier.verify(auth);
    if (!actor) {
      throw new UnauthorizedException('Access to this practice has ended');
    }
    request.auth = { ...auth, role: actor.role };

    const missing = required?.filter((permission) => !hasPermission(actor.role, permission));
    if (missing?.length) {
      this.logger.warn(
        { userId: auth.userId, practiceId: auth.practiceId, role: actor.role, missing, method: request.method, path: request.path },
        'Permission denied',
      );
      throw new ForbiddenException('You do not have permission to do that');
    }
    return true;
  }
}
