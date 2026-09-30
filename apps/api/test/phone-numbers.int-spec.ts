import type { PhoneNumberSummary, Role } from '@frontdesk/shared';
import type { Db } from '../src/database/database.module.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { addPhoneNumber, listPhoneNumbers, PhoneAdminError, setPhoneNumberActive } from '../src/voice/phone-admin.js';
import { PhoneNumbersService } from '../src/voice/phone-numbers.service.js';
import { startTestApp } from './support/app.js';
import { as, signIn, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const ALPHA_NUMBER = '+14155550101';
const ALPHA_SECOND = '+14155550102';
const BETA_NUMBER = '+16175550199';
const OFF_NUMBER = '+12125550123';

describe('phone numbers', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let appDb: Db;
  let app: TestApp;
  let service: PhoneNumbersService;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  let suspended: SeededPractice;
  const token: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  let betaToken: string;

  const audit = (action: string) => owner.selectFrom('audit_logs').selectAll().where('action', '=', action).orderBy('occurred_at').execute();
  const inPractice = <T>(practiceId: string, work: Parameters<typeof withPracticeContext<T>>[2]) => withPracticeContext(appDb, { practiceId }, work);

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    appDb = connect(database.appUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    suspended = await seedPractice(owner, 'gone');
    await addMember(owner, alpha.practiceId, 'admin@alpha.test', 'admin');
    await addMember(owner, alpha.practiceId, 'staff@alpha.test', 'staff');
    await addMember(owner, alpha.practiceId, 'viewer@alpha.test', 'viewer');
    app = await startTestApp();
    service = app.get(PhoneNumbersService);
    token.owner = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    token.admin = (await signIn(app, { email: 'admin@alpha.test' })).session.accessToken;
    token.staff = (await signIn(app, { email: 'staff@alpha.test' })).session.accessToken;
    token.viewer = (await signIn(app, { email: 'viewer@alpha.test' })).session.accessToken;
    betaToken = (await signIn(app, { email: beta.ownerEmail })).session.accessToken;

    await addPhoneNumber(owner, { practice: 'alpha', number: ALPHA_NUMBER, label: 'Main line', providerSid: 'PN0000000001' });
    await addPhoneNumber(owner, { practice: 'alpha', number: ALPHA_SECOND });
    await addPhoneNumber(owner, { practice: 'beta', number: BETA_NUMBER, label: 'Beta desk' });
    await addPhoneNumber(owner, { practice: 'alpha', number: OFF_NUMBER });
    await setPhoneNumberActive(owner, OFF_NUMBER, false);
    await addPhoneNumber(owner, { practice: 'gone', number: '+13105550111' });
    await owner.updateTable('practices').set({ status: 'suspended' }).where('id', '=', suspended.practiceId).execute();
  });

  afterAll(async () => {
    await app.close();
    await appDb.destroy();
    await owner.destroy();
    await database.drop();
  });

  describe('finding the practice for a call: only from the dialed number', () => {
    it('returns the practice that owns an active number', async () => {
      expect(await service.resolvePractice(ALPHA_NUMBER)).toBe(alpha.practiceId);
      expect(await service.resolvePractice(ALPHA_SECOND)).toBe(alpha.practiceId);
      expect(await service.resolvePractice(BETA_NUMBER)).toBe(beta.practiceId);
    });

    it('returns nothing for a number nobody has, a switched-off number, or a suspended practice', async () => {
      expect(await service.resolvePractice('+14155559999')).toBeNull();
      expect(await service.resolvePractice(OFF_NUMBER)).toBeNull();
      expect(await service.resolvePractice('+13105550111')).toBeNull();
    });

    it('answers again once a number is switched back on', async () => {
      await setPhoneNumberActive(owner, OFF_NUMBER, true);
      expect(await service.resolvePractice(OFF_NUMBER)).toBe(alpha.practiceId);
      await setPhoneNumberActive(owner, OFF_NUMBER, false);
      expect(await service.resolvePractice(OFF_NUMBER)).toBeNull();
    });

    it.each([
      [''],
      ['4155550101'],
      ['+0415555010'],
      ['+1 415 555 0101'],
      ['tel:+14155550101'],
      ["+14155550101' or '1'='1"],
      ['+14155550101; drop table phone_numbers'],
      ['+141555501011234567'],
      ['anonymous'],
    ])('refuses %j without asking the database', async (dialed) => {
      expect(await service.resolvePractice(dialed)).toBeNull();
    });

    it('the database function reveals only a practice id, and cannot be used to list numbers', async () => {
      const { rows } = await appDb.executeQuery<{ result: unknown }>({ sql: 'select resolve_practice_by_number($1) as result', parameters: [ALPHA_NUMBER], query: { kind: 'RawNode' } } as never);
      expect(rows).toEqual([{ result: alpha.practiceId }]);
    });
  });

  describe('connecting numbers (the operator’s command)', () => {
    it('records who connected what, as the system, in the practice’s audit log', async () => {
      const added = await audit('phone_number.added');
      expect(added.map((row) => row.practice_id).sort()).toEqual([alpha.practiceId, alpha.practiceId, alpha.practiceId, beta.practiceId, suspended.practiceId].sort());
      expect(added[0]).toMatchObject({ actor_type: 'system', actor_user_id: null, target_type: 'phone_number' });
      expect(JSON.stringify(added)).not.toContain(ALPHA_NUMBER); // the audit log does not carry the numbers
    });

    it('audits switching a number off and on', async () => {
      expect((await audit('phone_number.disabled')).length).toBeGreaterThanOrEqual(1);
      expect((await audit('phone_number.enabled')).length).toBeGreaterThanOrEqual(1);
    });

    it('one number belongs to one practice, even another practice cannot take it', async () => {
      await expect(addPhoneNumber(owner, { practice: 'beta', number: ALPHA_NUMBER })).rejects.toThrow(/already connected/);
      await expect(addPhoneNumber(owner, { practice: 'alpha', number: ALPHA_NUMBER })).rejects.toThrow(/already connected/);
      expect(await service.resolvePractice(ALPHA_NUMBER)).toBe(alpha.practiceId);
    });

    it.each([
      ['a number without a country code', { practice: 'alpha', number: '4155550123' }, /international phone number/],
      ['a number with spaces', { practice: 'alpha', number: '+1 415 555 0123' }, /international phone number/],
      ['a practice that does not exist', { practice: 'nobody', number: '+14155550199' }, /no practice with the short name/],
      ['a short name with capitals', { practice: 'Alpha', number: '+14155550199' }, /short name/],
      ['a label over 80 characters', { practice: 'alpha', number: '+14155550199', label: 'x'.repeat(81) }, /80 characters/],
      ['a Twilio id with odd characters', { practice: 'alpha', number: '+14155550199', providerSid: 'PN 1; drop' }, /letters and digits/],
    ])('refuses %s, with a message the operator can act on', async (_name, input, message) => {
      await expect(addPhoneNumber(owner, input)).rejects.toThrow(message);
      await expect(addPhoneNumber(owner, input)).rejects.toBeInstanceOf(PhoneAdminError);
    });

    it('refuses to switch an unknown number, or one already in that state', async () => {
      await expect(setPhoneNumberActive(owner, '+14155550777', false)).rejects.toThrow(/not connected/);
      await expect(setPhoneNumberActive(owner, ALPHA_NUMBER, true)).rejects.toThrow(/already on/);
      await expect(setPhoneNumberActive(owner, OFF_NUMBER, false)).rejects.toThrow(/already off/);
    });

    it('lists every connected number with its practice', async () => {
      const all = await listPhoneNumbers(owner);
      expect(all).toContainEqual({ number: ALPHA_NUMBER, practice: 'alpha', label: 'Main line', active: true });
      expect(all).toContainEqual({ number: OFF_NUMBER, practice: 'alpha', label: '', active: false });
      expect(all).toContainEqual({ number: BETA_NUMBER, practice: 'beta', label: 'Beta desk', active: true });
    });
  });

  describe('the API’s database role can look, never change', () => {
    it('sees only its own practice’s numbers', async () => {
      const mine = await inPractice(alpha.practiceId, (trx) => trx.selectFrom('phone_numbers').select('e164').orderBy('e164').execute());
      expect(mine.map((row) => row.e164)).toEqual([OFF_NUMBER, ALPHA_NUMBER, ALPHA_SECOND]); // sorted by number
      const theirs = await inPractice(beta.practiceId, (trx) => trx.selectFrom('phone_numbers').select('e164').execute());
      expect(theirs.map((row) => row.e164)).toEqual([BETA_NUMBER]);
    });

    it('sees nothing at all without a practice', async () => {
      expect(await appDb.selectFrom('phone_numbers').selectAll().execute()).toEqual([]);
    });

    it('cannot add, change or delete a number (so no practice can claim another’s)', async () => {
      await expect(
        inPractice(beta.practiceId, (trx) => trx.insertInto('phone_numbers').values({ practice_id: beta.practiceId, e164: '+14155550188' }).execute()),
      ).rejects.toThrow(/permission denied/);
      await expect(inPractice(alpha.practiceId, (trx) => trx.updateTable('phone_numbers').set({ active: false }).execute())).rejects.toThrow(/permission denied/);
      await expect(inPractice(alpha.practiceId, (trx) => trx.deleteFrom('phone_numbers').execute())).rejects.toThrow(/permission denied/);
      expect(await service.resolvePractice(ALPHA_NUMBER)).toBe(alpha.practiceId);
    });
  });

  describe('GET /api/ai/phone-numbers', () => {
    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])('as %s -> %i', async (role, status) => {
      await as(app, token[role]).get('/api/ai/phone-numbers').expect(status);
    });

    it('needs a login', async () => {
      await as(app, 'no-token').get('/api/ai/phone-numbers').expect(401);
    });

    it('shows a practice only its own numbers, off ones after on ones', async () => {
      const mine = (await as(app, token.staff).get('/api/ai/phone-numbers').expect(200)).body as PhoneNumberSummary[];
      expect(mine.map((n) => [n.number, n.active])).toEqual([[ALPHA_NUMBER, true], [ALPHA_SECOND, true], [OFF_NUMBER, false]]);
      expect(mine[0]).toMatchObject({ label: 'Main line' });
      expect(Object.keys(mine[0]!).sort()).toEqual(['active', 'id', 'label', 'number']); // no provider ids or practice ids

      const theirs = (await as(app, betaToken).get('/api/ai/phone-numbers').expect(200)).body as PhoneNumberSummary[];
      expect(theirs.map((n) => n.number)).toEqual([BETA_NUMBER]);
    });

    it('cannot be used to add or change numbers', async () => {
      await as(app, token.owner).post('/api/ai/phone-numbers', { number: '+14155550166' }).expect(404);
      await as(app, token.owner).patch('/api/ai/phone-numbers', { number: '+14155550166' }).expect(404);
    });
  });

  describe('what a phone conversation records', () => {
    let alphaNumberId: string;
    let betaNumberId: string;
    const insert = (practiceId: string, values: Record<string, unknown>) =>
      owner
        .insertInto('conversations')
        .values({ practice_id: practiceId, channel: 'phone', ...values } as never)
        .execute();

    beforeAll(async () => {
      alphaNumberId = (await owner.selectFrom('phone_numbers').select('id').where('e164', '=', ALPHA_NUMBER).executeTakeFirstOrThrow()).id;
      betaNumberId = (await owner.selectFrom('phone_numbers').select('id').where('e164', '=', BETA_NUMBER).executeTakeFirstOrThrow()).id;
    });

    it('stores the call, who called, which number, and how long', async () => {
      await insert(alpha.practiceId, { provider_call_sid: 'CA_ok_1', caller_number: '+16505550199', phone_number_id: alphaNumberId, duration_seconds: 42 });
      const row = await owner.selectFrom('conversations').selectAll().where('provider_call_sid', '=', 'CA_ok_1').executeTakeFirstOrThrow();
      expect(row).toMatchObject({ channel: 'phone', caller_number: '+16505550199', phone_number_id: alphaNumberId, duration_seconds: 42 });
    });

    it('a phone conversation must say which call it is', async () => {
      await expect(insert(alpha.practiceId, {})).rejects.toThrow(/check constraint/);
    });

    it('one call is one conversation, however often the provider repeats its request', async () => {
      await insert(alpha.practiceId, { provider_call_sid: 'CA_dup' });
      await expect(insert(alpha.practiceId, { provider_call_sid: 'CA_dup' })).rejects.toThrow(/unique|duplicate/);
    });

    it('the same call id in two different practices is fine (they never see each other)', async () => {
      await insert(alpha.practiceId, { provider_call_sid: 'CA_shared' });
      await insert(beta.practiceId, { provider_call_sid: 'CA_shared' });
    });

    it('a conversation cannot point at another practice’s number', async () => {
      await expect(insert(alpha.practiceId, { provider_call_sid: 'CA_cross', phone_number_id: betaNumberId })).rejects.toThrow(/foreign key/);
    });

    it.each([
      ['a caller number that is not international', { caller_number: '6505550199' }],
      ['an anonymous caller stored as text', { caller_number: 'anonymous' }],
      ['a negative duration', { duration_seconds: -1 }],
      ['an empty call id', { provider_call_sid: '' }],
    ])('refuses %s', async (_name, values) => {
      await expect(insert(alpha.practiceId, { provider_call_sid: 'CA_bad', ...values })).rejects.toThrow(/check constraint/);
    });

    it('the API role can record the duration at the end of a call, but not change who called or which call it was', async () => {
      const sid = 'CA_update';
      await insert(alpha.practiceId, { provider_call_sid: sid, caller_number: '+16505550199' });
      await inPractice(alpha.practiceId, (trx) => trx.updateTable('conversations').set({ duration_seconds: 90 }).where('provider_call_sid', '=', sid).execute());
      expect((await owner.selectFrom('conversations').select('duration_seconds').where('provider_call_sid', '=', sid).executeTakeFirstOrThrow()).duration_seconds).toBe(90);
      await expect(inPractice(alpha.practiceId, (trx) => trx.updateTable('conversations').set({ caller_number: '+16505550100' }).where('provider_call_sid', '=', sid).execute())).rejects.toThrow(/permission denied/);
      await expect(inPractice(alpha.practiceId, (trx) => trx.updateTable('conversations').set({ provider_call_sid: 'CA_other' }).where('provider_call_sid', '=', sid).execute())).rejects.toThrow(/permission denied/);
    });
  });
});
