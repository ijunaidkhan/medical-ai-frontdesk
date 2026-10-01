import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import type { Db } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import { as, signIn, uniqueIp, type TestApp } from './support/auth-helpers.js';
import { connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

/** With the default settings (no VOICE_PROVIDER) the phone routes do not exist. */
describe('phone routes while voice is switched off', () => {
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

  it.each(['incoming', 'action'])('/api/voice/%s answers 404 to everyone, even with a signature header', async (route) => {
    await request(app.getHttpServer()).post(`/api/voice/${route}`).set('X-Forwarded-For', uniqueIp()).type('form').send({ CallSid: 'CA1', To: '+14155550101' }).expect(404);
    await request(app.getHttpServer()).post(`/api/voice/${route}`).set('X-Forwarded-For', uniqueIp()).set('X-Twilio-Signature', 'anything').type('form').send({ CallSid: 'CA1' }).expect(404);
  });

  it('a signed-in user does not reach them either', async () => {
    const token = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    await request(app.getHttpServer()).post('/api/voice/incoming').set('Authorization', `Bearer ${token}`).type('form').send({}).expect(404);
  });

  it('nothing listens for live voice sessions: a WebSocket attempt never connects, whatever it carries', async () => {
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as unknown as Server).address() as AddressInfo;
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/relay?token=anything`, { headers: { 'X-Twilio-Signature': 'anything' } });
      ws.once('open', () => {
        ws.terminate();
        resolve('opened');
      });
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(`refused ${response.statusCode}`);
      });
      ws.once('error', () => resolve('failed to connect'));
    });
    expect(outcome).not.toBe('opened');
  });

  it('the rest of the API is unaffected', async () => {
    const token = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    await as(app, token).get('/api/ai/phone-numbers').expect(200);
  });
});
