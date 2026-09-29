import type { PinoLogger } from 'nestjs-pino';
import type { Db } from '../database/database.module.js';
import { HealthController } from './health.controller.js';

// Readiness talks to a real database, so it is covered by test/health-ready.int-spec.ts.
describe('HealthController', () => {
  it('reports liveness without touching the database', () => {
    const untouchedDb = new Proxy({}, { get: () => { throw new Error('database must not be used'); } }) as Db;
    const logger = { setContext: () => undefined } as unknown as PinoLogger;

    expect(new HealthController(untouchedDb, logger).live()).toEqual({ status: 'ok' });
  });
});
