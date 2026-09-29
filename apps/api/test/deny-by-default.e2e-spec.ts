import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Role } from '@frontdesk/shared';
import { SignJWT } from 'jose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import type { AuthContext } from '../src/auth/auth-context.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/auth/auth.constants.js';
import { Public } from '../src/auth/public.decorator.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { ActorVerifier } from '../src/tenancy/actor-verifier.js';
import { Authenticated, RequirePermissions } from '../src/tenancy/permissions.decorator.js';

/**
 * Stand-ins for routes future milestones will add. Each carries only the access
 * rule under test, so these tests prove the protection comes from the global
 * guards. (The database lookup is replaced by a stub here; the real one is
 * covered against a real database in the integration tests.)
 */
@Controller('probe')
class ProbeController {
  @Get('no-rule')
  noRule() {
    return { reached: true };
  }

  @Authenticated()
  @Get('any-member')
  anyMember() {
    return { reached: true };
  }

  @RequirePermissions('audit:read')
  @Get('audit')
  audit() {
    return { reached: true };
  }

  @RequirePermissions('practice:read', 'members:manage')
  @Get('needs-both')
  needsBoth() {
    return { reached: true };
  }

  @Public()
  @Get('open')
  open() {
    return { reached: true };
  }
}

const IDENTITY = {
  userId: '0190a1b2-c3d4-7e5f-8a9b-000000000001',
  practiceId: '0190a1b2-c3d4-7e5f-8a9b-000000000002',
  sessionId: '0190a1b2-c3d4-7e5f-8a9b-000000000003',
};

describe('access rules enforced by the global guards', () => {
  let app: INestApplication<App>;
  let tokens: AccessTokenService;
  /** What the (stubbed) database says about the caller right now. null = access ended. */
  let currentRole: Role | null;
  let verifiedWith: AuthContext | undefined;

  /** Calls a probe route with a valid token that claims `tokenRole`. Use `.expect(status)`. */
  const call = (path: string, tokenRole: Role = 'owner') => ({
    expect: async (status: number) => {
      const { token } = await tokens.sign({ ...IDENTITY, role: tokenRole });
      return request(app.getHttpServer()).get(`/api/probe/${path}`).set('Authorization', `Bearer ${token}`).expect(status);
    },
  });

  beforeAll(async () => {
    const verifier = {
      verify: async (auth: AuthContext) => {
        verifiedWith = auth;
        return currentRole ? { role: currentRole } : null;
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] })
      .overrideProvider(ActorVerifier)
      .useValue(verifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    tokens = app.get(AccessTokenService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    currentRole = 'owner';
    verifiedWith = undefined;
  });

  describe('authentication (any route without @Public)', () => {
    it.each(['no-rule', 'any-member', 'audit', 'needs-both'])('%s refuses a request with no token', async (path) => {
      await request(app.getHttpServer()).get(`/api/probe/${path}`).expect(401);
    });

    it('refuses a token signed with the wrong key', async () => {
      const forged = await new SignJWT({ pid: IDENTITY.practiceId, role: 'owner', sid: IDENTITY.sessionId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(IDENTITY.userId)
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode('an-attackers-guess-0123456789abcdefghij'));
      await request(app.getHttpServer()).get('/api/probe/any-member').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('serves a route explicitly marked @Public() without a token, and never consults the database', async () => {
      await request(app.getHttpServer()).get('/api/probe/open').expect(200);
      expect(verifiedWith).toBeUndefined();
    });
  });

  describe('a route with no access rule', () => {
    it('is refused even for an owner with a valid token (fails closed)', async () => {
      const res = await call('no-rule').expect(403);
      expect(res.body.message).toBe('This route has no access rule');
    });

    it('is refused before the database is consulted', async () => {
      await call('no-rule').expect(403);
      expect(verifiedWith).toBeUndefined();
    });
  });

  describe('@Authenticated()', () => {
    it.each<Role>(['owner', 'admin', 'staff', 'viewer'])('lets any active member in: %s', async (role) => {
      currentRole = role;
      await call('any-member', role).expect(200);
    });

    it('refuses someone whose access has ended', async () => {
      currentRole = null;
      const res = await call('any-member').expect(401);
      expect(res.body.message).toBe('Access to this practice has ended');
    });
  });

  describe('@RequirePermissions()', () => {
    it.each<[Role, number]>([
      ['owner', 200],
      ['admin', 200],
      ['staff', 403],
      ['viewer', 403],
    ])('audit:read for %s -> %i', async (role, status) => {
      currentRole = role;
      await call('audit', role).expect(status);
    });

    it('requires every listed permission', async () => {
      currentRole = 'admin';
      await call('needs-both', 'admin').expect(200);
      currentRole = 'staff'; // has practice:read but not members:manage
      await call('needs-both', 'staff').expect(403);
    });

    it('uses the role the database reports now, not the one written in the token', async () => {
      // Token says owner (issued before a demotion); the database says viewer.
      currentRole = 'viewer';
      await call('audit', 'owner').expect(403);
    });

    it('does not let a stale low role in the token block a promoted user from using what they now may do (after re-login)', async () => {
      // Guard uses the database role, so a token minted as viewer but now owner is accepted; safe because the DB is authoritative.
      currentRole = 'owner';
      await call('audit', 'viewer').expect(200);
    });

    it('refuses someone whose access has ended, whatever the token says', async () => {
      currentRole = null;
      await call('audit', 'owner').expect(401);
    });

    it('passes the verified identity on to the database check', async () => {
      await call('audit').expect(200);
      expect(verifiedWith).toMatchObject(IDENTITY);
    });
  });
});
