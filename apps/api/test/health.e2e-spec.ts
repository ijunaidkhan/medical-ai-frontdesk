import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

// No database is needed here: nothing in these tests queries it.
describe('API foundation (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health/live returns ok without a login', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('sets security headers and forbids caching', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('echoes a safe request ID and replaces an unsafe one', async () => {
    const safe = await request(app.getHttpServer()).get('/api/health/live').set('x-request-id', 'trace-1234567890');
    expect(safe.headers['x-request-id']).toBe('trace-1234567890');

    const unsafe = await request(app.getHttpServer()).get('/api/health/live').set('x-request-id', 'bad id!');
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: 'not found' });
    expect(typeof res.body.requestId).toBe('string');
  });

  it('allows the configured CORS origin and no other', async () => {
    const allowed = await request(app.getHttpServer()).get('/api/health/live').set('Origin', 'http://localhost:4200');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:4200');

    const denied = await request(app.getHttpServer()).get('/api/health/live').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  describe('deny by default', () => {
    it.each([
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/switch-practice'],
    ])('%s %s requires an access token', async (method, path) => {
      const res = await request(app.getHttpServer())[method === 'GET' ? 'get' : 'post'](path).expect(401);
      expect(res.body).toMatchObject({ statusCode: 401 });
    });

    it('rejects a malformed Authorization header', async () => {
      await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', 'Basic dXNlcjpwYXNz').expect(401);
      await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', 'Bearer').expect(401);
      await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
    });
  });
});
