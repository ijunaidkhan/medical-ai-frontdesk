// Session and rate-limit policy. Changing these changes security behaviour:
// keep them in one place and covered by tests.

/** Lifetime of a bearer access token. Also the worst-case delay before a role change takes effect. */
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

/** A refresh token not used within this window expires (idle timeout, e.g. a closed laptop). */
export const REFRESH_TOKEN_IDLE_TTL_SECONDS = 30 * 60;

/** Absolute session length regardless of activity (roughly one shift). */
export const SESSION_MAX_SECONDS = 12 * 60 * 60;

/**
 * A just-rotated refresh token presented again within this window is treated
 * as a benign race (two tabs refreshing at once) instead of theft: the request
 * is refused, but the session is not revoked.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 20;

export const JWT_ISSUER = 'frontdesk-api';
export const JWT_AUDIENCE = 'frontdesk-web';

/** Per client IP. `ttl` is in milliseconds. */
export const DEFAULT_RATE_LIMIT = { ttl: 60_000, limit: 300 };
export const LOGIN_RATE_LIMIT = { ttl: 60_000, limit: 20 };
export const REFRESH_RATE_LIMIT = { ttl: 60_000, limit: 60 };
