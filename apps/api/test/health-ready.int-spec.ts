import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { createDatabase, DB } from '../src/database/database.module.js';

async function startApp(overrideDb?: ReturnType<typeof createDatabase>): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (overrideDb) {
    builder = builder.overrideProvider(DB).useValue(overrideDb);
  }
  const app = (await builder.compile()).createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

describe('GET /health/ready', () => {
  it('reports ok when the database is reachable', async () => {
    const app = await startApp();
    try {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
    } finally {
      await app.close();
    }
  });

  it('reports 503 without leaking connection details when the database is down', async () => {
    // Port 1 refuses connections immediately.
    const app = await startApp(createDatabase('postgres://nobody:hunter2@127.0.0.1:1/nowhere'));
    try {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
      expect(res.body).toEqual({ status: 'unavailable', checks: { database: 'down' } });
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
    } finally {
      await app.close();
    }
  });

  it('keeps liveness independent of the database', async () => {
    const app = await startApp(createDatabase('postgres://nobody:x@127.0.0.1:1/nowhere'));
    try {
      await request(app.getHttpServer()).get('/health/live').expect(200);
    } finally {
      await app.close();
    }
  });
});
