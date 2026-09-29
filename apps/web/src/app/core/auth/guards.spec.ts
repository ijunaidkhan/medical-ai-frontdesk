import type { ActivatedRouteSnapshot, RouterStateSnapshot, UrlTree } from '@angular/router';
import { provideRouter, Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import type { Role } from '@frontdesk/shared';
import { httpProviders, makeSession, signIn } from '../../testing/helpers';
import { authGuard, guestGuard, permissionGuard } from './guards';

describe('route guards', () => {
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), ...httpProviders()] });
    router = TestBed.inject(Router);
  });

  const run = (guard: typeof authGuard, url = '/team') =>
    TestBed.runInInjectionContext(() => guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot));
  const where = (result: unknown) => router.serializeUrl(result as UrlTree);

  describe('authGuard', () => {
    it('sends a signed-out visitor to the login page and remembers where they were going', () => {
      expect(where(run(authGuard, '/team?tab=2'))).toBe('/login?returnUrl=%2Fteam%3Ftab%3D2');
    });

    it('lets a signed-in person through', async () => {
      await signIn();
      expect(run(authGuard)).toBe(true);
    });
  });

  describe('guestGuard', () => {
    it('lets a signed-out visitor see the login page', () => {
      expect(run(guestGuard, '/login')).toBe(true);
    });

    it('sends someone already signed in to the dashboard', async () => {
      await signIn();
      expect(where(run(guestGuard, '/login'))).toBe('/dashboard');
    });
  });

  describe('permissionGuard', () => {
    it.each<[Role, boolean]>([['owner', true], ['admin', true], ['staff', true], ['viewer', false]])(
      'members:read for %s -> allowed: %s',
      async (role, allowed) => {
        await signIn(makeSession({ role }));
        const result = TestBed.runInInjectionContext(() => permissionGuard('members:read')({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot));
        expect(allowed ? result === true : where(result) === '/dashboard').toBe(true);
      },
    );

    it('refuses everyone who is signed out', () => {
      const result = TestBed.runInInjectionContext(() => permissionGuard('practice:read')({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot));
      expect(where(result)).toBe('/dashboard');
    });
  });
});
