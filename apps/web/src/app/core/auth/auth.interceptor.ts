import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/** These authenticate with the refresh cookie (or nothing), never with the access token. */
const COOKIE_AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/refresh', '/api/auth/logout']);

/**
 * Adds the access token to calls to our own API. If the API answers 401 (the
 * token expired), it renews the session once and repeats the call. Several
 * calls failing together share a single renewal. A call is repeated at most
 * once, so a genuine 401 can never loop.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const path = request.url.split('?')[0] ?? request.url;
  if (!request.url.startsWith('/api/') || COOKIE_AUTH_PATHS.has(path)) {
    return next(request);
  }

  const send = (token: string | null) =>
    next(token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request);

  return send(auth.accessToken()).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }
      return from(auth.refresh()).pipe(
        switchMap((renewed) => (renewed ? send(auth.accessToken()) : throwError(() => error))),
      );
    }),
  );
};
