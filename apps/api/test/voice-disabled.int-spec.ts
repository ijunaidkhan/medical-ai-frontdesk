import request from 'supertest';
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

  it('the rest of the API is unaffected', async () => {
    const token = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    await as(app, token).get('/api/ai/phone-numbers').expect(200);
  });
});
