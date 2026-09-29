import { UnauthorizedException } from '@nestjs/common';
import { SignJWT } from 'jose';
import type { AuthContext } from './auth-context.js';
import { AccessTokenService, MIN_SECRET_LENGTH } from './access-token.service.js';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants.js';

const SECRET = 'unit-test-signing-key-0123456789abcdef';
const CONTEXT: AuthContext = {
  userId: '0190a1b2-c3d4-7e5f-8a9b-000000000001',
  practiceId: '0190a1b2-c3d4-7e5f-8a9b-000000000002',
  sessionId: '0190a1b2-c3d4-7e5f-8a9b-000000000003',
  role: 'staff',
};

const encode = (secret: string) => new TextEncoder().encode(secret);
const now = () => Math.floor(Date.now() / 1000);

/** A token a hostile or buggy issuer might produce, for testing rejection. */
function forge(claims: Record<string, unknown>, options: { alg?: string; secret?: string; aud?: string; iss?: string; exp?: number } = {}) {
  return new SignJWT({ pid: CONTEXT.practiceId, role: CONTEXT.role, sid: CONTEXT.sessionId, ...claims })
    .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
    .setSubject(CONTEXT.userId)
    .setIssuer(options.iss ?? JWT_ISSUER)
    .setAudience(options.aud ?? JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? now() + 600)
    .sign(encode(options.secret ?? SECRET));
}

describe('AccessTokenService', () => {
  const service = new AccessTokenService(SECRET);

  it('round-trips the identity it signed', async () => {
    const { token, expiresAt } = await service.sign(CONTEXT);
    expect(await service.verify(token)).toEqual(CONTEXT);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 1000);
  });

  it('refuses a weak signing secret', () => {
    expect(() => new AccessTokenService('x'.repeat(MIN_SECRET_LENGTH - 1))).toThrow(/at least/);
  });

  it('does not put anything sensitive in the token', async () => {
    const { token } = await service.sign(CONTEXT);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'pid', 'role', 'sid', 'sub']);
  });

  describe('rejects', () => {
    const rejected = async (token: string) => {
      await expect(service.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
    };

    it('an expired token', async () => rejected(await forge({}, { exp: now() - 60 })));
    it('a token signed with a different key', async () => rejected(await forge({}, { secret: 'a-completely-different-key-0123456789abc' })));
    it('a token for another audience', async () => rejected(await forge({}, { aud: 'someone-else' })));
    it('a token from another issuer', async () => rejected(await forge({}, { iss: 'someone-else' })));
    it('a token using a different algorithm (HS512)', async () => rejected(await forge({}, { alg: 'HS512' })));

    it('an unsigned token ("alg: none")', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: CONTEXT.userId, pid: CONTEXT.practiceId, sid: CONTEXT.sessionId, role: 'owner', iss: JWT_ISSUER, aud: JWT_AUDIENCE, iat: now(), exp: now() + 600 }),
      ).toString('base64url');
      await rejected(`${header}.${payload}.`);
    });

    it('a token whose payload was edited after signing (privilege escalation)', async () => {
      const { token } = await service.sign(CONTEXT);
      const [header, payload, signature] = token.split('.') as [string, string, string];
      const edited = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
      edited['role'] = 'owner';
      await rejected(`${header}.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signature}`);
    });

    it.each([
      ['missing practice', { pid: undefined }],
      ['missing session', { sid: undefined }],
      ['unknown role', { role: 'superadmin' }],
      ['practice id that is not a uuid', { pid: "1' OR '1'='1" }],
    ])('a correctly signed token with bad claims: %s', async (_label, claims) => rejected(await forge(claims)));

    it.each(['', 'garbage', 'a.b', 'a.b.c', 'a.b.c.d'])('malformed input %j', rejected);
  });
});
