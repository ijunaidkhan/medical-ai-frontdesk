import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import type { Signal } from '@angular/core';
import { catchError, map, type Observable, of, startWith, switchMap } from 'rxjs';
import type { AuthService } from '../auth/auth.service';
import { errorMessage } from './api-error';

export type LoadState<T> =
  | { status: 'idle' } // not requested: the person may not see this data
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

/**
 * Loads data now and again whenever the signed-in practice changes, so a page
 * never shows one practice's data under another practice's name. When
 * `enabled` says no (the person lacks the permission) nothing is requested.
 * Call from an injection context (a field initialiser).
 */
export function loadForPractice<T>(
  auth: AuthService,
  fetch: () => Observable<T>,
  enabled: () => boolean = () => true,
): Signal<LoadState<T>> {
  const loading: LoadState<T> = { status: 'loading' };
  return toSignal(
    toObservable(auth.practiceId).pipe(
      switchMap(() => {
        if (!enabled()) {
          return of<LoadState<T>>({ status: 'idle' });
        }
        return fetch().pipe(
          map((data): LoadState<T> => ({ status: 'ready', data })),
          catchError((error: unknown) => of<LoadState<T>>({ status: 'error', message: errorMessage(error) })),
          startWith(loading),
        );
      }),
    ),
    { initialValue: loading },
  );
}
