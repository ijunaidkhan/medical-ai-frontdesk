import type { AiSettings, BusinessHours, Role, TransferTarget } from '@frontdesk/shared';
import { sql } from 'kysely';
import { createDatabase, type Db } from '../src/database/database.module.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { startTestApp } from './support/app.js';
import { as, signIn, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const SOME_UUID = '0190ffff-0000-7000-8000-000000000000';
const WEEK: Partial<BusinessHours> = {
  mon: [{ open: '09:00', close: '17:00' }],
  tue: [{ open: '09:00', close: '17:00' }],
  sat: [{ open: '09:00', close: '13:00' }],
};
const GREETING = 'Thank you for calling Alpha Family Clinic.';
const EMERGENCY = 'If this is a medical emergency, please hang up and call 911 right now.';
const COMPLETE = { greeting: GREETING, emergencyMessage: EMERGENCY, businessHours: WEEK };
const PROBLEM = { greeting: /greeting/, emergency: /emergency message/, hours: /business hours/ };

describe('AI receptionist settings', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  const token: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  let betaToken: string;
  let betaNumber: TransferTarget;

  const settings = async (t = token.admin) => (await as(app, t).get('/api/ai/settings').expect(200)).body as AiSettings;
  const save = (body: object, t = token.admin) => as(app, t).patch('/api/ai/settings', body);
  const addTarget = async (label: string, phone: string, purpose = 'front_desk', t = token.admin) =>
    (await as(app, t).post('/api/ai/transfer-targets', { label, phone, purpose }).expect(201)).body as TransferTarget;
  const audit = (action: string, practiceId = alpha.practiceId) =>
    owner.selectFrom('audit_logs').selectAll().where('action', '=', action).where('practice_id', '=', practiceId).orderBy('occurred_at').execute();
  const storedSettings = (practiceId = alpha.practiceId) => owner.selectFrom('ai_settings').selectAll().where('practice_id', '=', practiceId).executeTakeFirst();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    await addMember(owner, alpha.practiceId, 'admin@alpha.test', 'admin');
    await addMember(owner, alpha.practiceId, 'staff@alpha.test', 'staff');
    await addMember(owner, alpha.practiceId, 'viewer@alpha.test', 'viewer');
    app = await startTestApp();
    token.owner = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    token.admin = (await signIn(app, { email: 'admin@alpha.test' })).session.accessToken;
    token.staff = (await signIn(app, { email: 'staff@alpha.test' })).session.accessToken;
    token.viewer = (await signIn(app, { email: 'viewer@alpha.test' })).session.accessToken;
    betaToken = (await signIn(app, { email: beta.ownerEmail })).session.accessToken;
    betaNumber = await addTarget('Beta line', '+14155550300', 'other', betaToken);
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  describe('who may do what', () => {
    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])('reading settings and numbers as %s -> %i', async (role, status) => {
      await as(app, token[role]).get('/api/ai/settings').expect(status);
      await as(app, token[role]).get('/api/ai/transfer-targets').expect(status);
    });

    it.each<[Role, number]>([['owner', 400], ['admin', 400], ['staff', 403], ['viewer', 403]])(
      'changing settings as %s -> %i (400 = permitted, but the empty request changes nothing)',
      async (role, status) => {
        await save({}, token[role]).expect(status);
      },
    );

    it.each<[Role, string, number]>([['owner', '+14155550401', 201], ['admin', '+14155550402', 201], ['staff', '+14155550403', 403], ['viewer', '+14155550404', 403]])(
      'adding a transfer number as %s -> %i',
      async (role, phone, status) => {
        await as(app, token[role]).post('/api/ai/transfer-targets', { label: `By ${role}`, phone, purpose: 'other' }).expect(status);
      },
    );

    it('everything needs a login', async () => {
      await as(app, 'no-token').get('/api/ai/settings').expect(401);
      await as(app, 'no-token').patch('/api/ai/settings', {}).expect(401);
      await as(app, 'no-token').post('/api/ai/transfer-targets', {}).expect(401);
    });
  });

  describe('a practice that has not set anything up', () => {
    it('starts off, empty, and not ready, saying what is missing', async () => {
      const fresh = await settings(betaToken);
      expect(fresh).toMatchObject({
        enabled: false,
        greeting: '',
        emergencyMessage: '',
        afterHoursAction: 'take_message',
        urgentAction: 'urgent_task',
        urgentTransferTargetId: null,
        extraUrgentPhrases: [],
        updatedAt: null,
        ready: false,
      });
      expect(fresh.problems).toEqual([expect.stringMatching(PROBLEM.greeting), expect.stringMatching(PROBLEM.emergency), expect.stringMatching(PROBLEM.hours)]);
      expect(Object.keys(fresh.businessHours)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
      expect(await storedSettings(beta.practiceId)).toBeUndefined(); // reading does not create anything
    });
  });

  describe('the AI cannot be switched on until it is safe', () => {
    it('refuses, and lists everything still missing, when nothing is set', async () => {
      const res = await save({ enabled: true }).expect(409);
      expect(res.body.message).toEqual([expect.stringMatching(PROBLEM.greeting), expect.stringMatching(PROBLEM.emergency), expect.stringMatching(PROBLEM.hours)]);
      expect(await storedSettings()).toBeUndefined();
    });

    it.each([
      ['no emergency message', { greeting: GREETING, businessHours: WEEK }, PROBLEM.emergency],
      ['an emergency message too short to say anything', { ...COMPLETE, emergencyMessage: '911' }, PROBLEM.emergency],
      ['no greeting', { emergencyMessage: EMERGENCY, businessHours: WEEK }, PROBLEM.greeting],
      ['no business hours', { greeting: GREETING, emergencyMessage: EMERGENCY }, PROBLEM.hours],
    ])('refuses to switch on with %s', async (_label, body, problem) => {
      const res = await save({ ...body, enabled: true }, token.owner).expect(409);
      expect(JSON.stringify(res.body.message)).toMatch(problem);
      expect(await storedSettings()).toBeUndefined(); // nothing was saved, not even the parts that were fine
    });

    it('can be filled in first (still off), then switched on once complete', async () => {
      const filled = (await save(COMPLETE).expect(200)).body as AiSettings;
      expect(filled).toMatchObject({ enabled: false, greeting: GREETING, emergencyMessage: EMERGENCY, ready: true, problems: [] });
      expect(filled.businessHours.mon).toEqual([{ open: '09:00', close: '17:00' }]);
      expect(filled.businessHours.wed).toEqual([]);
      expect(filled.updatedAt).not.toBeNull();

      const on = (await save({ enabled: true }).expect(200)).body as AiSettings;
      expect(on.enabled).toBe(true);
      expect((await audit('ai.enabled')).length).toBe(1);
    });

    it('cannot be left on while the emergency message, greeting or hours are removed: turn it off first', async () => {
      const blank = await save({ emergencyMessage: '' }).expect(409);
      expect(JSON.stringify(blank.body.message)).toMatch(PROBLEM.emergency);
      await save({ greeting: '   ' }).expect(409);
      await save({ businessHours: {} }).expect(409);
      expect(await storedSettings()).toMatchObject({ enabled: true, emergency_message: EMERGENCY, greeting: GREETING });

      await save({ enabled: false }).expect(200); // turning off is always allowed
      const cleared = (await save({ emergencyMessage: '' }).expect(200)).body as AiSettings;
      expect(cleared).toMatchObject({ enabled: false, emergencyMessage: '', ready: false });
      await save({ emergencyMessage: EMERGENCY }).expect(200);
    });

    it('records switching on and off, and what else changed, without any of the wording', async () => {
      await save({ enabled: true }).expect(200);
      await save({ enabled: false }).expect(200);
      expect((await audit('ai.disabled')).length).toBeGreaterThan(0);
      const updates = await audit('ai.settings_updated');
      expect(updates.length).toBeGreaterThan(0);
      for (const entry of updates) {
        expect(Object.keys(entry.metadata as object)).toEqual(['fields']);
      }
      expect(JSON.stringify(updates)).not.toContain(GREETING);
      expect(JSON.stringify(updates)).not.toContain('911');
    });
  });

  describe('transfer numbers', () => {
    it('are added, and can be renamed', async () => {
      const desk = await addTarget('Front desk', '+14155550101');
      const oncall = await addTarget('Dr. on call', '+14155550102', 'on_call');
      expect(desk).toEqual({ id: expect.any(String), label: 'Front desk', phone: '+14155550101', purpose: 'front_desk', active: true });

      const renamed = (await as(app, token.admin).patch(`/api/ai/transfer-targets/${oncall.id}`, { label: '  On-call doctor ' }).expect(200)).body as TransferTarget;
      expect(renamed.label).toBe('On-call doctor');
      const list = (await as(app, token.staff).get('/api/ai/transfer-targets').expect(200)).body as TransferTarget[];
      expect(list.map((t) => t.label)).toEqual(expect.arrayContaining(['Front desk', 'On-call doctor']));
    });

    it.each([
      ['no label', { phone: '+14155550111', purpose: 'other' }],
      ['a blank label', { label: ' ', phone: '+14155550111', purpose: 'other' }],
      ['a label over 80 characters', { label: 'l'.repeat(81), phone: '+14155550111', purpose: 'other' }],
      ['a phone without a country code', { label: 'x', phone: '415-555-0111', purpose: 'other' }],
      ['a phone that is too short', { label: 'x', phone: '+123', purpose: 'other' }],
      ['an unknown purpose', { label: 'x', phone: '+14155550111', purpose: 'sales' }],
      ['an attempt to choose the practice', { label: 'x', phone: '+14155550111', purpose: 'other', practiceId: SOME_UUID }],
      ['an attempt to add it already inactive', { label: 'x', phone: '+14155550111', purpose: 'other', active: false }],
    ])('rejects adding with %s', async (_label, body) => {
      await as(app, token.admin).post('/api/ai/transfer-targets', body).expect(400);
    });

    it('does not allow the same phone number twice in one practice, but another practice may use it', async () => {
      await addTarget('Duplicate test', '+14155550150');
      await as(app, token.admin).post('/api/ai/transfer-targets', { label: 'Again', phone: '+14155550150', purpose: 'other' }).expect(409);
      await as(app, betaToken).post('/api/ai/transfer-targets', { label: 'Beta shared number', phone: '+14155550150', purpose: 'other' }).expect(201);
    });

    it('cannot be changed to a phone that another number already has', async () => {
      const a = await addTarget('Swap A', '+14155550161');
      await addTarget('Swap B', '+14155550162');
      await as(app, token.admin).patch(`/api/ai/transfer-targets/${a.id}`, { phone: '+14155550162' }).expect(409);
    });

    describe('updating', () => {
      let target: TransferTarget;
      beforeAll(async () => {
        target = await addTarget('Strict update', '+14155550170');
      });

      it.each([
        ['nothing', {}],
        ['values it already has', { label: 'Strict update', active: true }],
        ['an unknown purpose', { purpose: 'sales' }],
        ['a bad phone', { phone: 'call me' }],
        ['a null label', { label: null }],
        ['an attempt to move it to another practice', { practiceId: SOME_UUID }],
      ])('rejects an update with %s', async (_label, body) => {
        await as(app, token.admin).patch(`/api/ai/transfer-targets/${target.id}`, body).expect(400);
      });
    });

    it('answers 400 for an id that is not a UUID and 404 for one that does not exist', async () => {
      await as(app, token.admin).patch('/api/ai/transfer-targets/nope', { label: 'x' }).expect(400);
      await as(app, token.admin).patch(`/api/ai/transfer-targets/${SOME_UUID}`, { label: 'x' }).expect(404);
    });

    it('records adding and changing a number without its phone number or name', async () => {
      const target = await addTarget('Audit me', '+14155550177');
      await as(app, token.admin).patch(`/api/ai/transfer-targets/${target.id}`, { label: 'Audit me too' }).expect(200);
      const created = (await audit('ai.transfer_target_created')).find((e) => e.target_id === target.id)!;
      const updated = (await audit('ai.transfer_target_updated')).find((e) => e.target_id === target.id)!;
      expect(created.metadata).toEqual({ purpose: 'front_desk' });
      expect(updated.metadata).toEqual({ fields: ['label'] });
      expect(JSON.stringify([created, updated])).not.toMatch(/4155550177|Audit me/);
    });
  });

  describe('choosing transfer numbers in the settings', () => {
    let desk: TransferTarget;
    let other: TransferTarget;
    beforeAll(async () => {
      desk = await addTarget('Choose: front desk', '+14155550201');
      other = await addTarget('Choose: other', '+14155550202');
    });

    it('needs an active number when urgent calls or after-hours calls are transferred', async () => {
      await save({ urgentAction: 'transfer' }).expect(200); // fine while the AI is off...
      expect((await settings()).problems.join(' ')).toMatch(/transfer number for urgent calls/);
      await save({ enabled: true }).expect(409); // ...but it cannot be switched on
      await save({ urgentTransferTargetId: desk.id }).expect(200);
      expect((await settings()).ready).toBe(true);

      await save({ afterHoursAction: 'transfer' }).expect(200);
      expect((await settings()).problems.join(' ')).toMatch(/after-hours/);
      await save({ afterHoursTransferTargetId: other.id }).expect(200);
      expect((await settings()).ready).toBe(true);
    });

    it('cannot choose a number that does not exist, or one that belongs to another practice', async () => {
      for (const id of [SOME_UUID, betaNumber.id]) {
        const res = await save({ urgentTransferTargetId: id }).expect(400);
        expect(res.body.message).toBe('That transfer number does not exist or is not active');
      }
    });

    it('cannot choose an inactive number', async () => {
      const spare = await addTarget('Choose: spare', '+14155550203');
      await as(app, token.admin).patch(`/api/ai/transfer-targets/${spare.id}`, { active: false }).expect(200);
      await save({ afterHoursTransferTargetId: spare.id }).expect(400);
    });

    it('cannot be deactivated while the settings still use it', async () => {
      const res = await as(app, token.admin).patch(`/api/ai/transfer-targets/${desk.id}`, { active: false }).expect(409);
      expect(res.body.message).toMatch(/still use this number/);

      await save({ urgentAction: 'urgent_task', urgentTransferTargetId: null }).expect(200); // stop using it
      await as(app, token.admin).patch(`/api/ai/transfer-targets/${desk.id}`, { active: false }).expect(200); // now it is free
    });
  });

  describe('input validation', () => {
    it.each([
      ['a greeting over 500 characters', { greeting: 'g'.repeat(501) }],
      ['a greeting that is not text', { greeting: 42 }],
      ['an emergency message over 500 characters', { emergencyMessage: 'e'.repeat(501) }],
      ['enabled given as text', { enabled: 'yes' }],
      ['enabled given as null', { enabled: null }],
      ['an unknown after-hours action', { afterHoursAction: 'ignore' }],
      ['an unknown urgent action', { urgentAction: 'shrug' }],
      ['a transfer target that is not an id', { urgentTransferTargetId: 'front desk' }],
      ['more than 30 urgent phrases', { extraUrgentPhrases: Array.from({ length: 31 }, (_, i) => `phrase ${i}`) }],
      ['an urgent phrase that is one letter', { extraUrgentPhrases: ['x'] }],
      ['an urgent phrase over 80 characters', { extraUrgentPhrases: ['p'.repeat(81)] }],
      ['urgent phrases that are not a list', { extraUrgentPhrases: 'panic' }],
      ['an urgent phrase that is not text', { extraUrgentPhrases: [7] }],
      ['hours with an unknown day', { businessHours: { monday: [] } }],
      ['hours where closing is before opening', { businessHours: { mon: [{ open: '17:00', close: '09:00' }] } }],
      ['hours with overlapping periods', { businessHours: { mon: [{ open: '08:00', close: '13:00' }, { open: '12:00', close: '17:00' }] } }],
      ['hours that are not an object', { businessHours: 'nine to five' }],
      ['an attempt to choose the practice', { practiceId: SOME_UUID }],
      ['an attempt to name who updated it', { updatedBy: SOME_UUID }],
    ])('rejects %s', async (_label, body) => {
      await save(body).expect(400);
    });

    it('rejects an empty update, and one that changes nothing', async () => {
      await save({}).expect(400);
      await save({ greeting: (await settings()).greeting }).expect(400);
    });

    it('trims the wording and keeps each extra urgent phrase once, ignoring capital letters', async () => {
      const saved = (await save({ extraUrgentPhrases: ['  self harm ', 'Self Harm', 'overdose', 'OVERDOSE', 'hurt myself'] }).expect(200)).body as AiSettings;
      expect(saved.extraUrgentPhrases).toEqual(['self harm', 'overdose', 'hurt myself']);
    });

    it('gives back the hours in order, with every day present', async () => {
      const saved = (await save({ businessHours: { fri: [{ open: '13:00', close: '17:00' }, { open: '08:00', close: '12:00' }] } }).expect(200)).body as AiSettings;
      expect(saved.businessHours.fri).toEqual([{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }]);
      expect(saved.businessHours.mon).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it('keeps each practice’s settings and numbers to itself', async () => {
      await as(app, betaToken).patch('/api/ai/settings', { greeting: 'Beta greeting', emergencyMessage: 'Beta: call 999 in an emergency, please.' }).expect(200);
      expect((await settings(betaToken)).greeting).toBe('Beta greeting');
      expect((await settings()).greeting).toBe(GREETING);

      const alphaLabels = ((await as(app, token.admin).get('/api/ai/transfer-targets').expect(200)).body as TransferTarget[]).map((t) => t.label);
      const betaLabels = ((await as(app, betaToken).get('/api/ai/transfer-targets').expect(200)).body as TransferTarget[]).map((t) => t.label);
      expect(alphaLabels).not.toContain('Beta line');
      expect(alphaLabels).not.toContain('Beta shared number');
      expect(betaLabels.sort()).toEqual(['Beta line', 'Beta shared number']);
    });

    it('cannot change another practice’s number: it does not exist for them', async () => {
      await as(app, token.admin).patch(`/api/ai/transfer-targets/${betaNumber.id}`, { label: 'hijacked' }).expect(404);
      expect((await owner.selectFrom('transfer_targets').select('label').where('id', '=', betaNumber.id).executeTakeFirstOrThrow()).label).toBe('Beta line');
    });

    describe('in the database itself', () => {
      let appDb: Db;
      beforeAll(() => {
        appDb = createDatabase(database.appUrl);
      });
      afterAll(async () => {
        await appDb.destroy();
      });

      it.each(['ai_settings', 'transfer_targets'] as const)('%s shows nothing without a practice context', async (table) => {
        const { rows } = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(appDb);
        expect(Number(rows[0]?.n)).toBe(0);
      });

      it('cannot delete settings or numbers, or write for another practice', async () => {
        const inAlpha = <T>(work: (trx: Parameters<Parameters<typeof withPracticeContext>[2]>[0]) => Promise<T>) =>
          withPracticeContext(appDb, { practiceId: alpha.practiceId }, work);
        await expect(inAlpha((trx) => trx.deleteFrom('ai_settings').execute())).rejects.toThrow(/permission denied/);
        await expect(inAlpha((trx) => trx.deleteFrom('transfer_targets').execute())).rejects.toThrow(/permission denied/);
        await expect(inAlpha((trx) => trx.updateTable('ai_settings').set({ practice_id: beta.practiceId }).execute())).rejects.toThrow(/permission denied/);
        await expect(
          inAlpha((trx) => trx.insertInto('transfer_targets').values({ practice_id: beta.practiceId, label: 'x', phone: '+14155550999', purpose: 'other' }).execute()),
        ).rejects.toThrow(/row-level security/);
      });

      it('cannot point one practice’s settings at another practice’s number (foreign key)', async () => {
        await expect(
          owner.updateTable('ai_settings').set({ urgent_transfer_target_id: betaNumber.id, urgent_action: 'transfer' }).where('practice_id', '=', alpha.practiceId).execute(),
        ).rejects.toThrow(/foreign key/);
      });

      it('refuses to switch the AI on without a greeting or an emergency message, even for the database owner', async () => {
        await expect(owner.updateTable('ai_settings').set({ enabled: true, emergency_message: '  ' }).where('practice_id', '=', alpha.practiceId).execute()).rejects.toThrow(/check constraint/);
        await expect(owner.updateTable('ai_settings').set({ enabled: true, greeting: '' }).where('practice_id', '=', alpha.practiceId).execute()).rejects.toThrow(/check constraint/);
        const gamma = await seedPractice(owner, 'gamma');
        await expect(
          owner
            .insertInto('ai_settings')
            .values({
              practice_id: gamma.practiceId,
              enabled: true,
              greeting: 'Hi',
              after_hours_action: 'take_message',
              after_hours_transfer_target_id: null,
              emergency_message: '',
              urgent_action: 'urgent_task',
              urgent_transfer_target_id: null,
              extra_urgent_phrases: [],
              business_hours: {} as BusinessHours,
              updated_by: null,
            })
            .execute(),
        ).rejects.toThrow(/check constraint/);
      });
    });
  });
});
