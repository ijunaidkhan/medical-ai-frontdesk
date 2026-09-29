import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createDatabase } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

describe('GET /api/health/ready', () => {
  let database: IsolatedDatabase;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
  });

  afterAll(async () => {
    await database.drop();
  });

  async function withApp(work: (app: INestApplication<App>) => Promise<void>, unreachable = false): Promise<void> {
    // Port 1 refuses connections immediately.
    const app = await startTestApp(unreachable ? { database: createDatabase('postgres://nobody:hunter2@127.0.0.1:1/nowhere') } : {});
    try {
      await work(app);
    } finally {
      await app.close();
    }
  }

  it('reports ok when the database is reachable', () =>
    withApp(async (app) => {
      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
    }));

  it('reports 503 without leaking connection details when the database is down', () =>
    withApp(async (app) => {
      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
      expect(res.body).toEqual({ status: 'unavailable', checks: { database: 'down' } });
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
    }, true));

  it('keeps liveness independent of the database', () =>
    withApp(async (app) => {
      await request(app.getHttpServer()).get('/api/health/live').expect(200);
    }, true));

  it('needs no login and is never rate limited', () =>
    withApp(async (app) => {
      for (let i = 0; i < 350; i++) {
        // The default limit is 300 requests a minute per client; probes are exempt.
        await request(app.getHttpServer()).get('/api/health/live').expect(200);
      }
    }));
});
