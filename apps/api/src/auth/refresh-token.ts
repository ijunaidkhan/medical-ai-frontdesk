import { createHash, randomBytes } from 'node:crypto';

/**
 * Refresh token format: `<practiceId>.<secret>`
 *
 * The practice id tells the API which tenant's row-level-security context to
 * look the token up in (refresh happens before any access token is trusted).
 * It grants nothing by itself: the lookup is by a hash of the whole value, so
 * editing the practice id just makes the token unknown. The secret is 256
 * random bits, so a fast SHA-256 is an appropriate hash (no brute force risk).
 */
const TOKEN_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export interface RefreshToken {
  /** Sent to the browser in the cookie. Never stored or logged. */
  value: string;
  /** Stored in refresh_tokens.token_hash. */
  hash: Buffer;
}

export function hashRefreshToken(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createRefreshToken(practiceId: string): RefreshToken {
  const value = `${practiceId.toLowerCase()}.${randomBytes(32).toString('base64url')}`;
  return { value, hash: hashRefreshToken(value) };
}

/** Returns null for anything that is not a well-formed token. */
export function parseRefreshToken(value: unknown): { practiceId: string; hash: Buffer } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = TOKEN_PATTERN.exec(value);
  if (!match?.[1]) {
    return null;
  }
  return { practiceId: match[1], hash: hashRefreshToken(value) };
}
