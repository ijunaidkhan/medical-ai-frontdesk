import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/auth/auth.constants.js';
import { Public } from '../src/auth/public.decorator.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

/**
 * Stand-ins for routes future milestones will add. They deliberately carry NO
 * authentication code of their own, so these tests prove that protection comes
 * from the global guard alone (a forgotten decorator must fail safe, not open).
 */
@Controller('probe')
class ProbeController {
  @Get('protected')
  protectedRoute() {
    return { reached: true };
  }

  @Public()
  @Get('open')
  openRoute() {
    return { reached: true };
  }
}

const IDENTITY = {
  userId: '0190a1b2-c3d4-7e5f-8a9b-000000000001',
  practiceId: '0190a1b2-c3d4-7e5f-8a9b-000000000002',
  sessionId: '0190a1b2-c3d4-7e5f-8a9b-000000000003',
  role: 'viewer' as const,
};

describe('deny by default (a route with no decorators of its own)', () => {
  let app: INestApplication<App>;
  let tokens: AccessTokenService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    tokens = app.get(AccessTokenService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a request with no token', async () => {
    await request(app.getHttpServer()).get('/api/probe/protected').expect(401);
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
    await request(app.getHttpServer()).get('/api/probe/protected').set('Authorization', `Bearer ${forged}`).expect(401);
  });

  it('lets a request with a valid token through', async () => {
    const { token } = await tokens.sign(IDENTITY);
    const res = await request(app.getHttpServer()).get('/api/probe/protected').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toEqual({ reached: true });
  });

  it('serves a route explicitly marked @Public() without a token', async () => {
    await request(app.getHttpServer()).get('/api/probe/open').expect(200);
  });
});
