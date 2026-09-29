import request from 'supertest';
import type { Db } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import { GENERIC_LOGIN_ERROR, loginRequest, type TestApp, uniqueIp } from './support/auth-helpers.js';
import { connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

describe('rate limiting', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  it('allows 20 login attempts a minute per client address, then answers 429', async () => {
    const ip = uniqueIp();
    // Use a different account name each time so lockout does not interfere with what is being tested.
    for (let i = 0; i < 20; i++) {
      await loginRequest(app, { email: `nobody${i}@alpha.test` }, ip).expect(401);
    }
    const limited = await loginRequest(app, { email: alpha.ownerEmail }, ip).expect(429);
    expect(limited.body).toMatchObject({ statusCode: 429 });
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('limits even a correct password once the budget is spent', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 20; i++) {
      await loginRequest(app, { email: `nobody${i}@alpha.test` }, ip).expect(401);
    }
    await loginRequest(app, { email: alpha.ownerEmail }, ip).expect(429);
  });

  it('counts each client address separately', async () => {
    const noisy = uniqueIp();
    for (let i = 0; i < 21; i++) {
      await loginRequest(app, { email: `nobody${i}@alpha.test` }, noisy);
    }
    await loginRequest(app, { email: alpha.ownerEmail }, uniqueIp()).expect(200);
  });

  it('cannot be dodged by sending a fake X-Forwarded-For from the client side', async () => {
    // One trusted proxy: only the LAST address in the header (the one the proxy appended) counts.
    const real = uniqueIp();
    for (let i = 0; i < 20; i++) {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-For', `${uniqueIp()}, ${real}`)
        .send({ email: `nobody${i}@alpha.test`, password: 'x'.repeat(16) })
        .expect(401);
    }
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', `${uniqueIp()}, ${real}`)
      .send({ email: alpha.ownerEmail, password: 'x'.repeat(16) })
      .expect(429);
  });

  it('limits the refresh route too', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 60; i++) {
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Origin', 'http://localhost:4200')
        .expect(401);
    }
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('X-Forwarded-For', ip)
      .set('Origin', 'http://localhost:4200')
      .expect(429);
  });

  it('still returns the generic message for ordinary failures under the limit', async () => {
    const res = await loginRequest(app, { email: 'nobody@alpha.test' }, uniqueIp()).expect(401);
    expect(res.body.message).toBe(GENERIC_LOGIN_ERROR);
  });
});
