import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import type { Permission } from '@frontdesk/shared';
import { AuthService } from './auth.service';

/** Signed-in people only; everyone else goes to the login page and comes back afterwards. */
export const authGuard: CanActivateFn = (_route, state) => {
  if (inject(AuthService).isAuthenticated()) {
    return true;
  }
  return inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/** For the login page: someone already signed in has no reason to see it. */
export const guestGuard: CanActivateFn = () =>
  inject(AuthService).isAuthenticated() ? inject(Router).createUrlTree(['/dashboard']) : true;

/**
 * Hides pages the person may not use. This is a convenience only: the API
 * refuses the underlying requests regardless of what the browser does.
 */
export const permissionGuard =
  (permission: Permission): CanActivateFn =>
  () =>
    inject(AuthService).can(permission) ? true : inject(Router).createUrlTree(['/dashboard']);
