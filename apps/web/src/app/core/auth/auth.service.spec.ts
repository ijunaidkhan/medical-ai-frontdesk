import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Role } from '@frontdesk/shared';
import { httpProviders, makeSession, PRACTICE_A, PRACTICE_B, signIn } from '../../testing/helpers';
import { AuthService, REFRESH_RETRY_DELAY_MS } from './auth.service';

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: httpProviders() });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  describe('login', () => {
    it('sends the credentials once, trims the email, and becomes signed in', async () => {
      expect(auth.isAuthenticated()).toBe(false);
      const pending = auth.login('  jane@alpha.test ', 'a long enough passphrase');

      const request = http.expectOne('/api/auth/login');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ email: 'jane@alpha.test', password: 'a long enough passphrase' });
      expect(request.request.withCredentials).toBe(true);
      request.flush(makeSession());
      await pending;

      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.user()?.displayName).toBe('Jane Smith');
      expect(auth.practice()?.name).toBe(PRACTICE_A.name);
      expect(auth.role()).toBe('owner');
      expect(auth.accessToken()).toBe('access-token-1');
    });

    it('stays signed out and reports the failure when the credentials are refused', async () => {
      const pending = auth.login('jane@alpha.test', 'wrong');
      http.expectOne('/api/auth/login').flush({ message: 'Invalid email or password' }, { status: 401, statusText: 'Unauthorized' });

      await expect(pending).rejects.toMatchObject({ status: 401 });
      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.accessToken()).toBeNull();
    });

    it('keeps the access token in memory only: never in storage or cookies', async () => {
      await signIn(makeSession({ token: 'super-secret-access-token' }));

      const everythingStored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie;
      expect(everythingStored).not.toContain('super-secret-access-token');
      expect(localStorage.length + sessionStorage.length).toBe(0);
    });
  });

  describe('what the person may do (can)', () => {
    it.each<[Role, string[], string[]]>([
      ['owner', ['practice:read', 'practice:manage', 'members:read', 'members:manage', 'audit:read'], []],
      ['admin', ['practice:read', 'practice:manage', 'members:read', 'members:manage', 'audit:read'], []],
      ['staff', ['practice:read', 'members:read'], ['practice:manage', 'members:manage', 'audit:read']],
      ['viewer', ['practice:read'], ['practice:manage', 'members:read', 'members:manage', 'audit:read']],
    ])('%s', async (role, allowed, denied) => {
      await signIn(makeSession({ role }));
      for (const permission of allowed) expect(auth.can(permission as never)).toBe(true);
      for (const permission of denied) expect(auth.can(permission as never)).toBe(false);
    });

    it('allows nothing when signed out', () => {
      expect(auth.can('practice:read')).toBe(false);
      expect(auth.role()).toBeNull();
    });
  });

  describe('restore (at startup)', () => {
    it('signs back in silently when the refresh cookie is still good', async () => {
      const pending = auth.restore();
      const request = http.expectOne('/api/auth/refresh');
      expect(request.request.method).toBe('POST');
      expect(request.request.withCredentials).toBe(true);
      request.flush(makeSession({ token: 'restored-token' }));
      await pending;

      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.accessToken()).toBe('restored-token');
    });

    it('is quick and quiet when there is no session: one request, no retry, no error', async () => {
      const pending = auth.restore();
      http.expectOne('/api/auth/refresh').flush({}, { status: 401, statusText: 'Unauthorized' });
      await expect(pending).resolves.toBeUndefined();

      expect(auth.isAuthenticated()).toBe(false);
      http.expectNone('/api/auth/refresh');
    });

    it('does not throw when the server cannot be reached', async () => {
      const pending = auth.restore();
      http.expectOne('/api/auth/refresh').error(new ProgressEvent('error'));
      await expect(pending).resolves.toBeUndefined();
      expect(auth.isAuthenticated()).toBe(false);
    });
  });

  describe('refresh', () => {
    it('replaces the access token', async () => {
      await signIn(makeSession({ token: 'old' }));
      const pending = auth.refresh();
      http.expectOne('/api/auth/refresh').flush(makeSession({ token: 'new' }));

      await expect(pending).resolves.toBe(true);
      expect(auth.accessToken()).toBe('new');
    });

    it('shares one request between callers that ask at the same moment', async () => {
      await signIn();
      const results = [auth.refresh(), auth.refresh(), auth.refresh()];
      http.expectOne('/api/auth/refresh').flush(makeSession({ token: 'shared' }));

      await expect(Promise.all(results)).resolves.toEqual([true, true, true]);
      http.expectNone('/api/auth/refresh');
    });

    it('can be used again once the first has finished', async () => {
      await signIn();
      const first = auth.refresh();
      http.expectOne('/api/auth/refresh').flush(makeSession({ token: 't1' }));
      await first;

      const second = auth.refresh();
      http.expectOne('/api/auth/refresh').flush(makeSession({ token: 't2' }));
      await second;
      expect(auth.accessToken()).toBe('t2');
    });

    describe('when the server refuses the cookie', () => {
      beforeEach(() => vi.useFakeTimers());

      it('tries once more after a moment (another tab may have just renewed it), and succeeds', async () => {
        await signIn();
        const pending = auth.refresh();
        http.expectOne('/api/auth/refresh').flush({}, { status: 401, statusText: 'Unauthorized' });
        await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
        http.expectOne('/api/auth/refresh').flush(makeSession({ token: 'after-race' }));

        await expect(pending).resolves.toBe(true);
        expect(auth.accessToken()).toBe('after-race');
      });

      it('gives up after the second refusal and signs the person out', async () => {
        await signIn();
        const pending = auth.refresh();
        http.expectOne('/api/auth/refresh').flush({}, { status: 401, statusText: 'Unauthorized' });
        await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
        http.expectOne('/api/auth/refresh').flush({}, { status: 401, statusText: 'Unauthorized' });

        await expect(pending).resolves.toBe(false);
        expect(auth.isAuthenticated()).toBe(false);
        expect(auth.accessToken()).toBeNull();
        http.expectNone('/api/auth/refresh');
      });
    });

    it('keeps the session through a server or network problem (it is not a refusal)', async () => {
      await signIn(makeSession({ token: 'keep-me' }));

      const serverError = auth.refresh();
      http.expectOne('/api/auth/refresh').flush({}, { status: 500, statusText: 'Server Error' });
      await expect(serverError).resolves.toBe(false);
      expect(auth.accessToken()).toBe('keep-me');

      const offline = auth.refresh();
      http.expectOne('/api/auth/refresh').error(new ProgressEvent('error'));
      await expect(offline).resolves.toBe(false);
      expect(auth.accessToken()).toBe('keep-me');
    });
  });

  describe('logout', () => {
    it('tells the server, then forgets the session', async () => {
      await signIn();
      const pending = auth.logout();
      const request = http.expectOne('/api/auth/logout');
      expect(request.request.method).toBe('POST');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await pending;

      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.accessToken()).toBeNull();
    });

    it('still forgets the session locally if the server cannot be reached', async () => {
      await signIn();
      const pending = auth.logout();
      http.expectOne('/api/auth/logout').error(new ProgressEvent('error'));
      await expect(pending).resolves.toBeUndefined();

      expect(auth.isAuthenticated()).toBe(false);
    });
  });

  describe('switchPractice', () => {
    it('moves to the other practice with that practice’s role', async () => {
      const practices = [{ ...PRACTICE_A, role: 'admin' as const }, PRACTICE_B];
      await signIn(makeSession({ practices }));
      expect(auth.practiceId()).toBe(PRACTICE_A.id);
      expect(auth.can('audit:read')).toBe(true);

      const pending = auth.switchPractice(PRACTICE_B.id);
      const request = http.expectOne('/api/auth/switch-practice');
      expect(request.request.body).toEqual({ practiceId: PRACTICE_B.id });
      request.flush(makeSession({ practices, current: PRACTICE_B, token: 'beta-token' }));
      await pending;

      expect(auth.practiceId()).toBe(PRACTICE_B.id);
      expect(auth.role()).toBe('viewer');
      expect(auth.can('audit:read')).toBe(false);
      expect(auth.accessToken()).toBe('beta-token');
    });

    it('stays in the current practice if the switch is refused', async () => {
      const practices = [PRACTICE_A, PRACTICE_B];
      await signIn(makeSession({ practices }));
      const pending = auth.switchPractice(PRACTICE_B.id);
      http.expectOne('/api/auth/switch-practice').flush({ message: 'nope' }, { status: 403, statusText: 'Forbidden' });

      await expect(pending).rejects.toMatchObject({ status: 403 });
      expect(auth.practiceId()).toBe(PRACTICE_A.id);
    });
  });
});
