import type { Role } from './roles.js';

/**
 * Password length rules (NIST SP 800-63B-4). 15 is the minimum for passwords
 * used as the only factor; revisit when multi-factor login is added.
 * No composition rules (e.g. "must contain a symbol"), per the same guidance.
 */
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

export interface LoginRequest {
  email: string;
  password: string;
  /** Practice to sign in to. Defaults to the user's first practice by name. */
  practiceId?: string;
}

export interface SwitchPracticeRequest {
  practiceId: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

export interface PracticeSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  /** The user's role in this practice. */
  role: Role;
}

/** Who is signed in, and where. Returned by GET /api/auth/me. */
export interface AuthProfile {
  user: AuthUser;
  /** The practice this session acts in (the tenant). */
  practice: PracticeSummary;
  /** Every practice the user may switch to, including the current one. */
  practices: PracticeSummary[];
}

/** Returned by login, refresh and switch-practice. */
export interface AuthSession extends AuthProfile {
  /** Short-lived bearer token. Keep in memory only, never in localStorage. */
  accessToken: string;
  /** ISO-8601 time at which accessToken expires. */
  accessTokenExpiresAt: string;
}
