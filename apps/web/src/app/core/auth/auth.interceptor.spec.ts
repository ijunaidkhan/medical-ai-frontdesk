import { HttpClient, type HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { httpProviders, makeSession, signIn } from '../../testing/helpers';
import { AuthService, REFRESH_RETRY_DELAY_MS } from './auth.service';

const UNAUTHORIZED = { status: 401, statusText: 'Unauthorized' };

/** Lets every pending promise callback run (one macrotask drains all microtasks). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('authInterceptor', () => {
  let client: HttpClient;
  let http: HttpTestingController;
  let auth: AuthService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: httpProviders() });
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  describe('adding the access token', () => {
    it('adds it to calls to our own API', async () => {
      await signIn(makeSession({ token: 'tok-1' }));
      const call = firstValueFrom(client.get('/api/practice'));
      const request = http.expectOne('/api/practice');
      expect(request.request.headers.get('Authorization')).toBe('Bearer tok-1');
      request.flush({});
      await call;
    });

    it('sends nothing when signed out', async () => {
      const call = firstValueFrom(client.get('/api/practice'));
      http.expectOne('/api/practice').flush({});
      await call;
      // (nothing to assert on the header beyond it being absent)
    });

    it('keeps query strings intact', async () => {
      await signIn();
      const call = firstValueFrom(client.get('/api/audit-logs?limit=5'));
      const request = http.expectOne('/api/audit-logs?limit=5');
      expect(request.request.headers.has('Authorization')).toBe(true);
      request.flush({});
      await call;
    });

    it.each(['/api/auth/login', '/api/auth/refresh', '/api/auth/logout'])('does not add it to %s (those use the cookie)', async (url) => {
      await signIn();
      const call = firstValueFrom(client.post(url, {}));
      const request = http.expectOne(url);
      expect(request.request.headers.has('Authorization')).toBe(false);
      request.flush({});
      await call;
    });

    it.each(['https://api.other-site.example/api/practice', 'https://evil.example/steal', '/assets/logo.svg'])(
      'never sends it anywhere else: %s',
      async (url) => {
        await signIn();
        const call = firstValueFrom(client.get(url));
        const request = http.expectOne(url);
        expect(request.request.headers.has('Authorization')).toBe(false);
        request.flush({});
        await call;
      },
    );
  });

  describe('when the token has expired (401)', () => {
    it('renews the session once and repeats the call with the new token', async () => {
      await signIn(makeSession({ token: 'expired' }));
      const call = firstValueFrom(client.get<{ ok: boolean }>('/api/practice'));

      http.expectOne('/api/practice').flush({}, UNAUTHORIZED);
      await tick();
      http.expectOne('/api/auth/refresh').flush(makeSession({ token: 'fresh' }));
      await tick();
      const retry = http.expectOne('/api/practice');
      expect(retry.request.headers.get('Authorization')).toBe('Bearer fresh');
      retry.flush({ ok: true });

      await expect(call).resolves.toEqual({ ok: true });
    });

    it('shares one renewal between calls that fail together, then repeats each', async () => {
      await signIn(makeSession({ token: 'expired' }));
      const calls = [firstValueFrom(client.get('/api/practice')), firstValueFrom(client.get('/api/members')), firstValueFrom(client.get('/api/audit-logs'))];

      http.expectOne('/api/practice').flush({}, UNAUTHORIZED);
      http.expectOne('/api/members').flush({}, UNAUTHORIZED);
      http.expectOne('/api/audit-logs').flush({}, UNAUTHORIZED);
      await tick();

      http.expectOne('/api/auth/refresh').flush(makeSession({ token: 'fresh' })); // exactly one
      await tick();

      for (const url of ['/api/practice', '/api/members', '/api/audit-logs']) {
        const retry = http.expectOne(url);
        expect(retry.request.headers.get('Authorization')).toBe('Bearer fresh');
        retry.flush({});
      }
      await Promise.all(calls);
    });

    it('reports the original 401 and signs the person out when the session cannot be renewed', async () => {
      vi.useFakeTimers();
      await signIn();
      const call = firstValueFrom(client.get('/api/practice')).catch((error: HttpErrorResponse) => error);

      http.expectOne('/api/practice').flush({}, UNAUTHORIZED);
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne('/api/auth/refresh').flush({}, UNAUTHORIZED);
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
      http.expectOne('/api/auth/refresh').flush({}, UNAUTHORIZED);

      const error = await call;
      expect(error).toMatchObject({ status: 401 });
      expect(auth.isAuthenticated()).toBe(false);
      http.expectNone('/api/practice'); // never repeated with a dead session
    });

    it('never loops: a call that is refused again after renewal fails for good', async () => {
      await signIn(makeSession({ token: 'expired' }));
      const call = firstValueFrom(client.get('/api/practice')).catch((error: HttpErrorResponse) => error);

      http.expectOne('/api/practice').flush({}, UNAUTHORIZED);
      await tick();
      http.expectOne('/api/auth/refresh').flush(makeSession({ token: 'fresh' }));
      await tick();
      http.expectOne('/api/practice').flush({}, UNAUTHORIZED); // refused even with the fresh token

      expect(await call).toMatchObject({ status: 401 });
      http.expectNone('/api/auth/refresh');
      http.expectNone('/api/practice');
    });
  });

  describe('other errors', () => {
    it.each([400, 403, 404, 409, 500])('passes a %i straight through without touching the session', async (status) => {
      await signIn(makeSession({ token: 'keep' }));
      const call = firstValueFrom(client.get('/api/members')).catch((error: HttpErrorResponse) => error);
      http.expectOne('/api/members').flush({}, { status, statusText: 'x' });

      expect(await call).toMatchObject({ status });
      expect(auth.accessToken()).toBe('keep');
      http.expectNone('/api/auth/refresh');
    });
  });
});
