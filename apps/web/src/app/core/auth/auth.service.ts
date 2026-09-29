import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { type AuthSession, hasPermission, type Permission } from '@frontdesk/shared';
import { firstValueFrom } from 'rxjs';

/** If a refresh is refused, wait this long and try once more (see refresh()). */
export const REFRESH_RETRY_DELAY_MS = 400;

const AUTH_URL = '/api/auth';

/**
 * The signed-in session, held in memory only.
 *
 * The access token is never written to localStorage, sessionStorage or a
 * cookie, so a script injected into the page cannot read it back later. The
 * long-lived refresh token is an httpOnly cookie the browser manages itself;
 * this code never sees it. A reload therefore starts signed out, and
 * restore() signs the person back in silently using that cookie.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly session = signal<AuthSession | null>(null);
  private inFlightRefresh: Promise<boolean> | null = null;

  readonly isAuthenticated = computed(() => this.session() !== null);
  readonly user = computed(() => this.session()?.user ?? null);
  readonly practice = computed(() => this.session()?.practice ?? null);
  readonly practices = computed(() => this.session()?.practices ?? []);
  readonly role = computed(() => this.session()?.practice.role ?? null);
  /** Changes only when the person moves to another practice. */
  readonly practiceId = computed(() => this.session()?.practice.id ?? null);

  accessToken(): string | null {
    return this.session()?.accessToken ?? null;
  }

  /** What the UI may offer. The API decides for real; this only avoids showing what would be refused. */
  can(permission: Permission): boolean {
    const role = this.role();
    return role !== null && hasPermission(role, permission);
  }

  async login(email: string, password: string): Promise<void> {
    const session = await firstValueFrom(
      this.http.post<AuthSession>(`${AUTH_URL}/login`, { email: email.trim(), password }, { withCredentials: true }),
    );
    this.session.set(session);
  }

  /** Called once at startup. Signs the person back in if their refresh cookie is still good. Never throws. */
  async restore(): Promise<void> {
    await this.refresh({ retryOnRefusal: false });
  }

  /**
   * Trades the refresh cookie for a new access token. Concurrent callers share
   * one request (each use of the cookie rotates it, so two at once would clash).
   *
   * Returns false when there is no session to renew. The session is only
   * cleared when the server refuses the cookie; a network hiccup keeps it.
   */
  refresh(options: { retryOnRefusal?: boolean } = {}): Promise<boolean> {
    this.inFlightRefresh ??= this.performRefresh(options.retryOnRefusal ?? true).finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async performRefresh(retryOnRefusal: boolean): Promise<boolean> {
    const attempts = retryOnRefusal ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const session = await firstValueFrom(
          this.http.post<AuthSession>(`${AUTH_URL}/refresh`, {}, { withCredentials: true }),
        );
        this.session.set(session);
        return true;
      } catch (error) {
        const refused = error instanceof HttpErrorResponse && (error.status === 401 || error.status === 403);
        if (!refused) {
          return false; // server or network trouble: keep whatever we have
        }
        // Two browser tabs refreshing at once: the API refuses the loser for a moment
        // while the winner's response replaces the shared cookie. Trying again picks it up.
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
        }
      }
    }
    this.session.set(null);
    return false;
  }

  /** Ends the session on the server, then forgets it here even if the request fails. */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post<void>(`${AUTH_URL}/logout`, {}, { withCredentials: true }));
    } catch {
      // Signing out locally still matters if the server cannot be reached.
    } finally {
      this.session.set(null);
    }
  }

  async switchPractice(practiceId: string): Promise<void> {
    const session = await firstValueFrom(
      this.http.post<AuthSession>(`${AUTH_URL}/switch-practice`, { practiceId }, { withCredentials: true }),
    );
    this.session.set(session);
  }
}
