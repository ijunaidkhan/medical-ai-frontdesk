import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@frontdesk/shared';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const AUTHENTICATED_KEY = 'anySignedInUser';

/**
 * The signed-in user must hold ALL of these permissions in their current
 * practice. Every route needs an access rule: this, @Authenticated(), or
 * @Public(). A route with none is refused, so a forgotten decorator fails safe.
 */
export const RequirePermissions = (...permissions: [Permission, ...Permission[]]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Any signed-in user with an active membership may use this route, whatever their role. */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);
