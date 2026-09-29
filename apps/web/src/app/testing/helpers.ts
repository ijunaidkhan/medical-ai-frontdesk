import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { EnvironmentProviders, Provider } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { AuthSession, PracticeSummary, Role } from '@frontdesk/shared';
import { authInterceptor } from '../core/auth/auth.interceptor';
import { AuthService } from '../core/auth/auth.service';

export const PRACTICE_A: PracticeSummary = {
  id: '0190a1b2-c3d4-7e5f-8a9b-00000000000a',
  name: 'Alpha Family Clinic',
  slug: 'alpha',
  timezone: 'America/New_York',
  role: 'owner',
};

export const PRACTICE_B: PracticeSummary = {
  id: '0190a1b2-c3d4-7e5f-8a9b-00000000000b',
  name: 'Beta Pediatrics',
  slug: 'beta',
  timezone: 'Asia/Karachi',
  role: 'viewer',
};

/** A session as the API would return it. */
export function makeSession(
  options: { role?: Role; practices?: PracticeSummary[]; token?: string; current?: PracticeSummary } = {},
): AuthSession {
  const role = options.role ?? 'owner';
  const practices = options.practices ?? [{ ...PRACTICE_A, role }];
  const practice = options.current ?? practices[0]!;
  return {
    accessToken: options.token ?? 'access-token-1',
    accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    user: { id: '0190a1b2-c3d4-7e5f-8a9b-0000000000aa', email: 'jane@alpha.test', displayName: 'Jane Smith' },
    practice,
    practices,
  };
}

/** HTTP setup that includes the real auth interceptor and a controllable fake backend. */
export function httpProviders(): Array<Provider | EnvironmentProviders> {
  return [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()];
}

/** Lets every pending promise callback run (one macrotask drains all microtasks). */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Renders and lets Angular's scheduled work (effects, resolved promises) finish.
 * Not fixture.whenStable(): HttpClient counts an unanswered request as pending work,
 * so whenStable() would wait for requests a test has deliberately not answered yet.
 */
export async function render(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await tick();
  fixture.detectChanges();
  await tick();
  fixture.detectChanges();
}

/** Signs in through the real AuthService, answering the login request with `session`. */
export async function signIn(session: AuthSession = makeSession()): Promise<AuthSession> {
  const auth = TestBed.inject(AuthService);
  const http = TestBed.inject(HttpTestingController);
  const pending = auth.login('jane@alpha.test', 'a long enough passphrase');
  http.expectOne('/api/auth/login').flush(session);
  await pending;
  return session;
}
