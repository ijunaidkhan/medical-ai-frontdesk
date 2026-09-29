import { UnauthorizedException } from '@nestjs/common';
import { isRole } from '@frontdesk/shared';
import { jwtVerify, SignJWT } from 'jose';
import { isUuid } from '../common/uuid.js';
import type { AuthContext } from './auth-context.js';
import { ACCESS_TOKEN_TTL_SECONDS, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants.js';

/** The only algorithm accepted. Pinning it blocks "alg: none" and algorithm-confusion attacks. */
const ALGORITHM = 'HS256';
export const MIN_SECRET_LENGTH = 32;

/**
 * Signs and verifies short-lived access tokens (JWT, HS256).
 * Claims: sub (user), pid (practice/tenant), role, sid (session).
 */
export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
  ) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`The access token secret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    this.key = new TextEncoder().encode(secret);
  }

  async sign(context: AuthContext): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.ttlSeconds;
    const token = await new SignJWT({ pid: context.practiceId, role: context.role, sid: context.sessionId })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setSubject(context.userId)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /** Throws UnauthorizedException for any invalid, expired or malformed token. */
  async verify(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        typ: 'JWT',
        requiredClaims: ['sub', 'iat', 'exp', 'pid', 'role', 'sid'],
        clockTolerance: 5,
      });
      const userId = payload.sub;
      const practiceId = payload['pid'];
      const sessionId = payload['sid'];
      const role = payload['role'];
      if (!isUuid(userId) || !isUuid(practiceId) || !isUuid(sessionId) || !isRole(role)) {
        throw new Error('Malformed claims');
      }
      return { userId, practiceId, sessionId, role };
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
