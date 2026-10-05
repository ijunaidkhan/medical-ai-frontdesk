import type { AppointmentType, AvailabilityResponse, Provider, ProviderTimeOff, Role, SchedulingSettings } from '@frontdesk/shared';
import { WEEKDAYS } from '@frontdesk/shared';
import type { Db } from '../src/database/database.module.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { startTestApp } from './support/app.js';
import { as, signIn, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const SOME_UUID = '0190ffff-0000-7000-8000-000000000000';
const day = 86_400_000;

/** A Monday at least ten days ahead, as midnight UTC (the test practice's clock is UTC). */
function nextMonday(): Date {
  const date = new Date(Date.now() + 10 * day);
  date.setUTCHours(0, 0, 0, 0);
  while (date.getUTCDay() !== 1) date.setTime(date.getTime() + day);
  return date;
}
const iso = (date: Date) => date.toISOString();
const MON_TO_FRI = Object.fromEntries(WEEKDAYS.map((d) => [d, ['sat', 'sun'].includes(d) ? [] : [{ open: '09:00', close: '12:00' }]]));

describe('scheduling foundations', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let appDb: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  const token: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  let betaToken: string;

  const get = <T>(path: string, t = token.staff) => as(app, t).get(path).expect(200).then((res) => res.body as T);
  const post = (path: string, body: object = {}, t = token.admin) => as(app, t).post(path, body);
  const patch = (path: string, body: object, t = token.admin) => as(app, t).patch(path, body);
  const audit = (action: string) => owner.selectFrom('audit_logs').selectAll().where('action', '=', action).orderBy('occurred_at').execute();
  const inAlpha = <T>(work: Parameters<typeof withPracticeContext<T>>[2]) => withPracticeContext(appDb, { practiceId: alpha.practiceId }, work);

  const newType = async (name: string, durationMinutes = 30, extra: object = {}, t = token.admin) =>
    (await post('/api/appointment-types', { name, durationMinutes, ...extra }, t).expect(201)).body as AppointmentType;
  const newProvider = async (name: string, extra: object = {}, t = token.admin) => (await post('/api/providers', { name, ...extra }, t).expect(201)).body as Provider;
  const rules = (body: object) => patch('/api/scheduling/settings', body).expect(200);

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    appDb = connect(database.appUrl);
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
  });

  afterAll(async () => {
    await app.close();
    await appDb.destroy();
    await owner.destroy();
    await database.drop();
  });

  // ------------------------------------------------------------------ access

  describe('who may do what', () => {
    let providerId: string;
    let typeId: string;
    let timeOffId: string;
    beforeAll(async () => {
      typeId = (await newType('Permissions probe')).id;
      providerId = (await newProvider('Probe provider', { hours: MON_TO_FRI, appointmentTypeIds: [typeId] })).id;
      timeOffId = ((await post(`/api/providers/${providerId}/time-off`, { startsAt: iso(new Date(Date.now() + 30 * day)), endsAt: iso(new Date(Date.now() + 31 * day)) }).expect(201)).body as ProviderTimeOff).id;
    });

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])('reading (providers, types, rules, time off, availability) as %s -> %i', async (role, status) => {
      for (const path of ['/api/providers', `/api/providers/${providerId}`, '/api/appointment-types', '/api/scheduling/settings', `/api/providers/${providerId}/time-off`, `/api/availability?appointmentTypeId=${typeId}`]) {
        await as(app, token[role]).get(path).expect(status);
      }
    });

    it.each<[Role, number]>([['owner', 201], ['admin', 201], ['staff', 403], ['viewer', 403]])('creating a provider or an appointment type as %s -> %i (setting up is for owners and admins)', async (role, status) => {
      await post('/api/providers', { name: `By ${role}` }, token[role]).expect(status);
      await post('/api/appointment-types', { name: `By ${role}`, durationMinutes: 20 }, token[role]).expect(status);
    });

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 403], ['viewer', 403]])('changing rules, providers, types and time off as %s -> %i', async (role, status) => {
      await patch('/api/scheduling/settings', { minNoticeHours: role === 'owner' ? 3 : 4 }, token[role]).expect(status);
      await patch(`/api/providers/${providerId}`, { title: `Set by ${role}` }, token[role]).expect(status);
      await patch(`/api/appointment-types/${typeId}`, { durationMinutes: role === 'owner' ? 31 : 32 }, token[role]).expect(status);
      await post(`/api/providers/${providerId}/time-off`, { startsAt: iso(new Date(Date.now() + 40 * day)), endsAt: iso(new Date(Date.now() + 41 * day)) }, token[role]).expect(status === 200 ? 201 : status);
    });

    it('cancelling time off is for owners and admins too', async () => {
      await post(`/api/provider-time-off/${timeOffId}/cancel`, {}, token.staff).expect(403);
      await post(`/api/provider-time-off/${timeOffId}/cancel`, {}, token.viewer).expect(403);
      await post(`/api/provider-time-off/${timeOffId}/cancel`, {}, token.admin).expect(200);
    });

    it('everything needs a login', async () => {
      for (const path of ['/api/providers', '/api/appointment-types', '/api/scheduling/settings', '/api/availability']) await as(app, 'no-token').get(path).expect(401);
      await as(app, 'no-token').post('/api/providers', {}).expect(401);
      await as(app, 'no-token').patch('/api/scheduling/settings', {}).expect(401);
    });
  });

  // ---------------------------------------------------------------- the rules

  describe('booking rules', () => {
    it('start with sensible defaults, with the AI not allowed to book', async () => {
      const fresh = await get<SchedulingSettings>('/api/scheduling/settings', betaToken);
      expect(fresh).toEqual({
        slotMinutes: 15,
        minNoticeHours: 2,
        maxAdvanceDays: 60,
        cancelMinHours: 24,
        aiBookingEnabled: false,
        timeFormat: '12h',
        identityFailureCapPerHour: 30,
        updatedAt: null,
      });
      expect(await owner.selectFrom('scheduling_settings').select('practice_id').where('practice_id', '=', beta.practiceId).executeTakeFirst()).toBeUndefined(); // reading creates nothing
    });

    it('can be changed one at a time or together, and are audited by field name only', async () => {
      const saved = (await rules({ slotMinutes: 30, minNoticeHours: 5 })).body as SchedulingSettings;
      expect(saved).toMatchObject({ slotMinutes: 30, minNoticeHours: 5, maxAdvanceDays: 60, cancelMinHours: 24 });
      expect(saved.updatedAt).not.toBeNull();
      const updated = (await audit('scheduling.settings_updated')).at(-1)!;
      expect(updated).toMatchObject({ actor_type: 'user', metadata: { fields: ['slotMinutes', 'minNoticeHours'] } });
      await rules({ slotMinutes: 15, minNoticeHours: 2, maxAdvanceDays: 90, cancelMinHours: 12 });
      expect(await get<SchedulingSettings>('/api/scheduling/settings')).toMatchObject({ slotMinutes: 15, minNoticeHours: 2, maxAdvanceDays: 90, cancelMinHours: 12 });
    });

    it('the clock format and the identity failure cap can be changed, and are audited by field name', async () => {
      const saved = (await rules({ timeFormat: '24h', identityFailureCapPerHour: 50 })).body as SchedulingSettings;
      expect(saved).toMatchObject({ timeFormat: '24h', identityFailureCapPerHour: 50 });
      const entry = (await audit('scheduling.settings_updated')).at(-1)!;
      expect(entry.metadata).toEqual({ fields: ['timeFormat', 'identityFailureCapPerHour'] });
      await patch('/api/scheduling/settings', { timeFormat: '24h', identityFailureCapPerHour: 50 }).expect(400); // nothing changed
      await rules({ timeFormat: '12h', identityFailureCapPerHour: 30 });
      await patch('/api/scheduling/settings', { identityFailureCapPerHour: 5 }, token.staff).expect(403); // staff cannot change the rules
      expect(await get<SchedulingSettings>('/api/scheduling/settings')).toMatchObject({ timeFormat: '12h', identityFailureCapPerHour: 30 });
    });

    it.each([
      ['a slot length that is not offered', { slotMinutes: 7 }],
      ['a slot length that is not a number', { slotMinutes: 'quarter' }],
      ['negative notice', { minNoticeHours: -1 }],
      ['more than 720 hours of notice', { minNoticeHours: 721 }],
      ['no days ahead at all', { maxAdvanceDays: 0 }],
      ['more than a year ahead', { maxAdvanceDays: 366 }],
      ['a cancellation window over 720 hours', { cancelMinHours: 721 }],
      ['a fraction', { minNoticeHours: 1.5 }],
      ['AI booking as text', { aiBookingEnabled: 'yes' }],
      ['a clock format that does not exist', { timeFormat: '13h' }],
      ['a clock format as a number', { timeFormat: 24 }],
      ['an identity failure cap below 5', { identityFailureCapPerHour: 4 }],
      ['an identity failure cap above 1000', { identityFailureCapPerHour: 1001 }],
      ['an identity failure cap that is not a whole number', { identityFailureCapPerHour: 10.5 }],
      ['an unknown field (a practice cannot be named)', { practiceId: SOME_UUID }],
    ])('refuses %s', async (_name, body) => {
      await patch('/api/scheduling/settings', body).expect(400);
    });

    it('refuses a request that changes nothing', async () => {
      await patch('/api/scheduling/settings', {}).expect(400);
      const current = await get<SchedulingSettings>('/api/scheduling/settings');
      await patch('/api/scheduling/settings', { slotMinutes: current.slotMinutes }).expect(400);
    });

    it('the AI cannot be allowed to book until there is something to book, and says what is missing', async () => {
      const res = await patch('/api/scheduling/settings', { aiBookingEnabled: true }, betaToken).expect(409);
      expect(res.body.message).toEqual(['Add at least one provider']);

      const t = (await as(app, betaToken).post('/api/appointment-types', { name: 'Visit', durationMinutes: 30 }).expect(201)).body as AppointmentType;
      const p = (await as(app, betaToken).post('/api/providers', { name: 'Dr Beta', appointmentTypeIds: [t.id] }).expect(201)).body as Provider;
      expect((await patch('/api/scheduling/settings', { aiBookingEnabled: true }, betaToken).expect(409)).body.message).toEqual(['Give a provider working hours']);

      await as(app, betaToken).patch(`/api/providers/${p.id}`, { appointmentTypeIds: [], hours: MON_TO_FRI }).expect(200);
      expect((await patch('/api/scheduling/settings', { aiBookingEnabled: true }, betaToken).expect(409)).body.message).toEqual(['Add an appointment type and choose which provider offers it']);

      await as(app, betaToken).patch(`/api/providers/${p.id}`, { appointmentTypeIds: [t.id] }).expect(200);
      expect(((await patch('/api/scheduling/settings', { aiBookingEnabled: true }, betaToken).expect(200)).body as SchedulingSettings).aiBookingEnabled).toBe(true);
      expect((await audit('scheduling.ai_booking_enabled')).length).toBe(1);

      expect(((await patch('/api/scheduling/settings', { aiBookingEnabled: false }, betaToken).expect(200)).body as SchedulingSettings).aiBookingEnabled).toBe(false); // always allowed
      expect((await audit('scheduling.ai_booking_disabled')).length).toBe(1);
    });
  });

  describe('the AI booking gate ignores anything switched off', () => {
    it('does not count a switched-off appointment type or a switched-off provider', async () => {
      const gamma = await seedPractice(owner, 'gamma');
      const t = (await signIn(app, { email: gamma.ownerEmail })).session.accessToken;
      const type = (await as(app, t).post('/api/appointment-types', { name: 'Visit', durationMinutes: 30 }).expect(201)).body as AppointmentType;
      const provider = (await as(app, t).post('/api/providers', { name: 'Dr Gamma', hours: MON_TO_FRI, appointmentTypeIds: [type.id] }).expect(201)).body as Provider;
      const enable = () => as(app, t).patch('/api/scheduling/settings', { aiBookingEnabled: true });

      await as(app, t).patch(`/api/appointment-types/${type.id}`, { active: false }).expect(200);
      expect((await enable().expect(409)).body.message).toEqual(['Add an appointment type and choose which provider offers it']);
      await as(app, t).patch(`/api/appointment-types/${type.id}`, { active: true }).expect(200);

      await as(app, t).patch(`/api/providers/${provider.id}`, { active: false }).expect(200);
      expect((await enable().expect(409)).body.message).toEqual(['Add at least one provider']);
      await as(app, t).patch(`/api/providers/${provider.id}`, { active: true }).expect(200);

      await enable().expect(200); // everything switched back on: now it is allowed
    });
  });

  // ---------------------------------------------------------------- providers

  describe('providers', () => {
    it('are created with a name, title, weekly hours and the visit types they offer', async () => {
      const type = await newType('Follow-up');
      const provider = await newProvider('  Dr Khan ', { title: 'Dr', hours: MON_TO_FRI, appointmentTypeIds: [type.id] });
      expect(provider).toMatchObject({ name: 'Dr Khan', title: 'Dr', active: true, appointmentTypeIds: [type.id] });
      expect(provider.hours.mon).toEqual([{ open: '09:00', close: '12:00' }]);
      expect(provider.hours.sat).toEqual([]);
      expect((await get<AppointmentType[]>('/api/appointment-types')).find((t) => t.id === type.id)!.providerIds).toEqual([provider.id]); // the link is visible from both sides
    });

    it('can be created with nothing but a name', async () => {
      expect(await newProvider('Room 2')).toMatchObject({ title: '', active: true, appointmentTypeIds: [] });
    });

    it.each([
      ['no name', {}],
      ['an empty name', { name: '   ' }],
      ['a name over 120 characters', { name: 'x'.repeat(121) }],
      ['a title over 120 characters', { name: 'Dr X', title: 'x'.repeat(121) }],
      ['hours that close before they open', { name: 'Dr X', hours: { ...MON_TO_FRI, mon: [{ open: '12:00', close: '09:00' }] } }],
      ['hours with overlapping periods', { name: 'Dr X', hours: { ...MON_TO_FRI, mon: [{ open: '09:00', close: '12:00' }, { open: '11:00', close: '13:00' }] } }],
      ['hours that are not hours', { name: 'Dr X', hours: 'always' }],
      ['an appointment type id that is not a UUID', { name: 'Dr X', appointmentTypeIds: ['nope'] }],
      ['the same appointment type twice', { name: 'Dr X', appointmentTypeIds: [SOME_UUID, SOME_UUID] }],
      ['an appointment type that does not exist', { name: 'Dr X', appointmentTypeIds: [SOME_UUID] }],
      ['an unknown field (a practice cannot be named)', { name: 'Dr X', practiceId: SOME_UUID }],
    ])('refuses %s', async (_name, body) => {
      await post('/api/providers', body).expect(400);
    });

    it('cannot offer another practice’s appointment type (it is treated as not existing)', async () => {
      const betaType = (await as(app, betaToken).post('/api/appointment-types', { name: 'Beta secret visit', durationMinutes: 30 }).expect(201)).body as AppointmentType;
      await post('/api/providers', { name: 'Dr Cross', appointmentTypeIds: [betaType.id] }).expect(400);
      expect(await owner.selectFrom('providers').select('id').where('name', '=', 'Dr Cross').executeTakeFirst()).toBeUndefined(); // nothing half-created
    });

    it('can be changed: only what changed is saved, types are replaced as a list, and it is audited by field name', async () => {
      const a = await newType('Type A');
      const b = await newType('Type B');
      const p = await newProvider('Dr Change', { appointmentTypeIds: [a.id] });
      const changed = (await patch(`/api/providers/${p.id}`, { name: 'Dr Changed', title: 'Dr', appointmentTypeIds: [b.id] }).expect(200)).body as Provider;
      expect(changed).toMatchObject({ name: 'Dr Changed', title: 'Dr', appointmentTypeIds: [b.id] });
      const event = (await audit('provider.updated')).find((row) => row.target_id === p.id)!;
      expect(event.metadata).toEqual({ fields: ['name', 'title', 'appointmentTypeIds'] });
      expect(JSON.stringify(event)).not.toContain('Dr Changed'); // names are not copied into the audit log
    });

    it('can be switched off and on again, but never deleted', async () => {
      const p = await newProvider('Dr Away');
      expect(((await patch(`/api/providers/${p.id}`, { active: false }).expect(200)).body as Provider).active).toBe(false);
      expect(((await patch(`/api/providers/${p.id}`, { active: true }).expect(200)).body as Provider).active).toBe(true);
      await as(app, token.admin).get(`/api/providers/${p.id}`).expect(200);
    });

    it('refuses a change that changes nothing, and unknown or other practices’ providers are "not found"', async () => {
      const p = await newProvider('Dr Same', { title: 'Dr' });
      await patch(`/api/providers/${p.id}`, { name: 'Dr Same', title: 'Dr' }).expect(400);
      await patch(`/api/providers/${p.id}`, {}).expect(400);
      await patch(`/api/providers/${SOME_UUID}`, { name: 'x' }).expect(404);
      await as(app, betaToken).get(`/api/providers/${p.id}`).expect(404);
      await as(app, betaToken).patch(`/api/providers/${p.id}`, { name: 'Hijacked' }).expect(404);
      await as(app, token.admin).get('/api/providers/not-a-uuid').expect(400);
    });

    it('are listed for their own practice only, active ones first, by name', async () => {
      const off = await newProvider('Aaa switched off');
      await patch(`/api/providers/${off.id}`, { active: false }).expect(200); // sorts first by name, must still come last
      const mine = await get<Provider[]>('/api/providers');
      const names = mine.map((p) => p.name);
      expect(names).not.toContain('Dr Beta');
      expect(names.at(-1)).toBe('Aaa switched off');
      const firstInactive = mine.findIndex((p) => !p.active);
      expect(firstInactive).toBeGreaterThan(0);
      expect(mine.slice(firstInactive).every((p) => !p.active)).toBe(true);
      expect(mine.slice(0, firstInactive).map((p) => p.name)).toEqual([...names.slice(0, firstInactive)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      expect((await get<Provider[]>('/api/providers', betaToken)).map((p) => p.name)).toEqual(['Dr Beta']);
    });
  });

  // -------------------------------------------------------- appointment types

  describe('appointment types', () => {
    it('have a name and a length in minutes between 5 and 480', async () => {
      expect(await newType('Five', 5)).toMatchObject({ durationMinutes: 5, active: true, providerIds: [] });
      expect(await newType('Eight hours', 480)).toMatchObject({ durationMinutes: 480 });
      for (const durationMinutes of [4, 481, 0, -5, 30.5]) await post('/api/appointment-types', { name: `Bad ${durationMinutes}`, durationMinutes }).expect(400);
      await post('/api/appointment-types', { name: 'No length' }).expect(400);
      await post('/api/appointment-types', { durationMinutes: 30 }).expect(400);
    });

    it('have unique names within a practice, but another practice may use the same name', async () => {
      await newType('Unique visit');
      await post('/api/appointment-types', { name: 'Unique visit', durationMinutes: 20 }).expect(409);
      await as(app, betaToken).post('/api/appointment-types', { name: 'Unique visit', durationMinutes: 20 }).expect(201);
    });

    it('can be changed and switched off; the change is audited without the name', async () => {
      const type = await newType('To change', 30);
      const changed = (await patch(`/api/appointment-types/${type.id}`, { name: 'Changed', durationMinutes: 45, active: false }).expect(200)).body as AppointmentType;
      expect(changed).toMatchObject({ name: 'Changed', durationMinutes: 45, active: false });
      const event = (await audit('appointment_type.updated')).find((row) => row.target_id === type.id)!;
      expect(event.metadata).toEqual({ fields: ['name', 'durationMinutes', 'active'] });
      await patch(`/api/appointment-types/${type.id}`, { name: 'Changed' }).expect(400);
      await patch(`/api/appointment-types/${SOME_UUID}`, { name: 'x' }).expect(404);
      await as(app, betaToken).patch(`/api/appointment-types/${type.id}`, { name: 'Hijacked' }).expect(404);
    });

    it('can be given to providers from the type’s side, and not to another practice’s providers', async () => {
      const provider = await newProvider('Dr Link');
      const type = await newType('Linked', 30, { providerIds: [provider.id] });
      expect(type.providerIds).toEqual([provider.id]);
      expect(((await get<Provider[]>('/api/providers')).find((p) => p.id === provider.id))!.appointmentTypeIds).toEqual([type.id]);
      const betaProvider = (await as(app, betaToken).post('/api/providers', { name: 'Dr Elsewhere' }).expect(201)).body as Provider;
      await post('/api/appointment-types', { name: 'Cross', durationMinutes: 30, providerIds: [betaProvider.id] }).expect(400);
      await patch(`/api/appointment-types/${type.id}`, { providerIds: [] }).expect(200);
      expect((await get<AppointmentType[]>('/api/appointment-types')).find((t) => t.id === type.id)!.providerIds).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- time off

  describe('time off', () => {
    let providerId: string;
    beforeAll(async () => {
      providerId = (await newProvider('Dr Holiday')).id;
    });
    const range = (fromDays: number, toDays: number) => ({ startsAt: iso(new Date(Date.now() + fromDays * day)), endsAt: iso(new Date(Date.now() + toDays * day)), reason: 'Holiday' });

    it('is added, listed (upcoming only), and cancelled but never deleted', async () => {
      const added = (await post(`/api/providers/${providerId}/time-off`, range(20, 22)).expect(201)).body as ProviderTimeOff;
      expect(added).toMatchObject({ providerId, reason: 'Holiday', active: true });
      await post(`/api/providers/${providerId}/time-off`, { startsAt: iso(new Date(Date.now() - 10 * day)), endsAt: iso(new Date(Date.now() - 9 * day)) }).expect(201); // already over
      expect((await get<ProviderTimeOff[]>(`/api/providers/${providerId}/time-off`)).map((t) => t.id)).toEqual([added.id]);

      expect(((await post(`/api/provider-time-off/${added.id}/cancel`).expect(200)).body as ProviderTimeOff).active).toBe(false);
      expect(await get<ProviderTimeOff[]>(`/api/providers/${providerId}/time-off`)).toEqual([]);
      await post(`/api/provider-time-off/${added.id}/cancel`).expect(409);
      expect((await owner.selectFrom('provider_time_off').select('active').where('id', '=', added.id).executeTakeFirstOrThrow()).active).toBe(false); // still there
      expect((await audit('time_off.created')).length).toBeGreaterThan(0);
      expect((await audit('time_off.cancelled')).length).toBeGreaterThan(0);
    });

    it.each([
      ['an end that is not after the start', () => ({ startsAt: iso(new Date(Date.now() + day)), endsAt: iso(new Date(Date.now() + day)) })],
      ['an end before the start', () => range(5, 4)],
      ['more than 366 days', () => range(1, 400)],
      ['dates that are not dates', () => ({ startsAt: 'tomorrow', endsAt: 'later' })],
      ['a missing end', () => ({ startsAt: iso(new Date()) })],
      ['a reason over 200 characters', () => ({ ...range(1, 2), reason: 'x'.repeat(201) })],
    ])('refuses %s', async (_name, body) => {
      await post(`/api/providers/${providerId}/time-off`, body()).expect(400);
    });

    it('treats an unknown provider, another practice’s provider or time off as not found', async () => {
      await post(`/api/providers/${SOME_UUID}/time-off`, range(1, 2)).expect(404);
      await as(app, betaToken).post(`/api/providers/${providerId}/time-off`, range(1, 2)).expect(404);
      await as(app, betaToken).get(`/api/providers/${providerId}/time-off`).expect(404);
      const added = (await post(`/api/providers/${providerId}/time-off`, range(50, 51)).expect(201)).body as ProviderTimeOff;
      await as(app, betaToken).post(`/api/provider-time-off/${added.id}/cancel`).expect(404);
      await post(`/api/provider-time-off/${SOME_UUID}/cancel`).expect(404);
    });
  });

  // ------------------------------------------------------------- availability

  describe('availability: what a caller would be offered', () => {
    let monday: Date;
    let visit: AppointmentType; // 30 minutes
    let longVisit: AppointmentType; // 60 minutes
    let drA: Provider;
    let drB: Provider;
    const search = (extra: Record<string, string | number>, t = token.staff) => {
      const query = new URLSearchParams(Object.entries(extra).map(([k, v]) => [k, String(v)])).toString();
      return as(app, t).get(`/api/availability?${query}`);
    };
    const times = (res: AvailabilityResponse) => res.slots.map((slot) => `${slot.startsAt.slice(11, 16)} ${slot.providerName}`);
    const window = () => ({ from: iso(monday), to: iso(new Date(monday.getTime() + day)) });

    beforeAll(async () => {
      monday = nextMonday();
      await rules({ slotMinutes: 30, minNoticeHours: 0, maxAdvanceDays: 365 });
      visit = await newType('Availability visit', 30);
      longVisit = await newType('Availability long visit', 60);
      drA = await newProvider('Dr A', { hours: MON_TO_FRI, appointmentTypeIds: [visit.id, longVisit.id] });
      drB = await newProvider('Dr B', { hours: { ...MON_TO_FRI, mon: [{ open: '10:00', close: '11:00' }] }, appointmentTypeIds: [visit.id] });
    });

    it('lists open start times from every provider who offers the visit, earliest first', async () => {
      const res = (await search({ appointmentTypeId: visit.id, ...window() }).expect(200)).body as AvailabilityResponse;
      expect(res.timezone).toBe('UTC');
      expect(times(res)).toEqual(['09:00 Dr A', '09:30 Dr A', '10:00 Dr A', '10:00 Dr B', '10:30 Dr A', '10:30 Dr B', '11:00 Dr A', '11:30 Dr A']);
      expect(res.slots[0]).toMatchObject({ providerId: drA.id, appointmentTypeId: visit.id, startsAt: iso(new Date(monday.getTime() + 9 * 3_600_000)), endsAt: iso(new Date(monday.getTime() + 9.5 * 3_600_000)) });
    });

    it('a longer visit leaves fewer start times, and only providers who offer it appear', async () => {
      const res = (await search({ appointmentTypeId: longVisit.id, ...window() }).expect(200)).body as AvailabilityResponse;
      expect(times(res)).toEqual(['09:00 Dr A', '09:30 Dr A', '10:00 Dr A', '10:30 Dr A', '11:00 Dr A']);
    });

    it('can be narrowed to one provider, and honours the limit', async () => {
      expect(times((await search({ appointmentTypeId: visit.id, providerId: drB.id, ...window() }).expect(200)).body)).toEqual(['10:00 Dr B', '10:30 Dr B']);
      expect(times((await search({ appointmentTypeId: visit.id, ...window(), limit: 3 }).expect(200)).body)).toEqual(['09:00 Dr A', '09:30 Dr A', '10:00 Dr A']);
    });

    it('time off removes the slots it covers, and cancelling it brings them back', async () => {
      const off = (await post(`/api/providers/${drA.id}/time-off`, { startsAt: iso(new Date(monday.getTime() + 9 * 3_600_000)), endsAt: iso(new Date(monday.getTime() + 10 * 3_600_000)) }).expect(201)).body as ProviderTimeOff;
      expect(times((await search({ appointmentTypeId: visit.id, providerId: drA.id, ...window() }).expect(200)).body)).toEqual(['10:00 Dr A', '10:30 Dr A', '11:00 Dr A', '11:30 Dr A']);
      await post(`/api/provider-time-off/${off.id}/cancel`).expect(200);
      expect((await search({ appointmentTypeId: visit.id, providerId: drA.id, ...window() }).expect(200)).body.slots).toHaveLength(6);
    });

    it('follows the practice’s rules: slot length and minimum notice', async () => {
      await rules({ slotMinutes: 60 });
      expect(times((await search({ appointmentTypeId: visit.id, providerId: drA.id, ...window() }).expect(200)).body)).toEqual(['09:00 Dr A', '10:00 Dr A', '11:00 Dr A']);
      await rules({ slotMinutes: 30 });

      await rules({ minNoticeHours: 720 }); // 30 days' notice: nothing at all on a Monday 10-17 days away
      expect((await search({ appointmentTypeId: visit.id, ...window() }).expect(200)).body.slots).toEqual([]);
      await rules({ minNoticeHours: 0 });
    });

    it('reads the hours on the practice’s own clock (Karachi is five hours ahead of UTC)', async () => {
      await owner.updateTable('practices').set({ timezone: 'Asia/Karachi' }).where('id', '=', alpha.practiceId).execute();
      try {
        const res = (await search({ appointmentTypeId: visit.id, providerId: drA.id, from: iso(new Date(monday.getTime() - 5 * 3_600_000)), to: iso(new Date(monday.getTime() + 19 * 3_600_000)), limit: 1 }).expect(200)).body as AvailabilityResponse;
        expect(res.timezone).toBe('Asia/Karachi');
        expect(res.slots[0]!.startsAt).toBe(iso(new Date(monday.getTime() + 4 * 3_600_000))); // 09:00 in Karachi is 04:00 UTC
      } finally {
        await owner.updateTable('practices').set({ timezone: 'UTC' }).where('id', '=', alpha.practiceId).execute();
      }
    });

    it('does not offer a provider who has been switched off, or a visit type that has been switched off', async () => {
      const gone = await newProvider('Dr Gone', { hours: MON_TO_FRI, appointmentTypeIds: [visit.id] });
      await patch(`/api/providers/${gone.id}`, { active: false }).expect(200);
      expect(times((await search({ appointmentTypeId: visit.id, ...window(), limit: 100 }).expect(200)).body).some((t) => t.includes('Dr Gone'))).toBe(false);
      await search({ appointmentTypeId: visit.id, providerId: gone.id, ...window() }).expect(404);

      const old = await newType('Retired visit', 30, { providerIds: [drA.id] });
      await patch(`/api/appointment-types/${old.id}`, { active: false }).expect(200);
      await search({ appointmentTypeId: old.id, ...window() }).expect(404);
    });

    it.each([
      ['no appointment type', {}],
      ['an appointment type that is not a UUID', { appointmentTypeId: 'visit' }],
      ['an appointment type that does not exist', { appointmentTypeId: SOME_UUID }],
      ['a limit of zero', { limit: 0 }],
      ['a limit above 100', { limit: 101 }],
      ['dates that are not dates', { from: 'monday', to: 'friday' }],
      ['an end before the start', { from: '2026-12-02T00:00:00Z', to: '2026-12-01T00:00:00Z' }],
      ['a window longer than 62 days', { from: '2026-12-01T00:00:00Z', to: '2027-03-01T00:00:00Z' }],
    ])('refuses %s', async (_name, extra) => {
      const query = { appointmentTypeId: visit.id, ...extra } as Record<string, string | number>;
      if (_name === 'no appointment type') delete query['appointmentTypeId'];
      const status = _name === 'an appointment type that does not exist' ? 404 : 400;
      await search(query).expect(status);
    });

    it('a provider who does not offer that visit is "not found"', async () => {
      await search({ appointmentTypeId: longVisit.id, providerId: drB.id, ...window() }).expect(404);
    });

    it('works with no dates at all (the next two weeks)', async () => {
      const res = (await search({ appointmentTypeId: visit.id }).expect(200)).body as AvailabilityResponse;
      expect(Array.isArray(res.slots)).toBe(true);
    });

    it('never shows another practice’s providers or types', async () => {
      await as(app, betaToken).get(`/api/availability?appointmentTypeId=${visit.id}`).expect(404);
      const betaType = (await get<AppointmentType[]>('/api/appointment-types', betaToken)).find((t) => t.name === 'Visit')!;
      const res = (await as(app, betaToken).get(`/api/availability?appointmentTypeId=${betaType.id}&from=${iso(monday)}&to=${iso(new Date(monday.getTime() + day))}`).expect(200)).body as AvailabilityResponse;
      expect(res.slots.every((slot) => slot.providerName === 'Dr Beta')).toBe(true);
    });
  });

  // ---------------------------------------------------------- database rules

  describe('the database enforces its own rules', () => {
    it('lets the API change a provider’s details but never who owns it, and never delete anything of record', async () => {
      const p = await newProvider('Dr Rules');
      await inAlpha((trx) => trx.updateTable('providers').set({ title: 'Changed' }).where('id', '=', p.id).execute());
      await expect(inAlpha((trx) => trx.updateTable('providers').set({ practice_id: beta.practiceId }).where('id', '=', p.id).execute())).rejects.toThrow(/permission denied/);
      for (const table of ['providers', 'appointment_types', 'provider_time_off', 'scheduling_settings'] as const) {
        await expect(inAlpha((trx) => trx.deleteFrom(table).execute())).rejects.toThrow(/permission denied/);
      }
    });

    it('lets a type be taken off a provider (a link is configuration, not a record)', async () => {
      const type = await newType('Removable');
      const p = await newProvider('Dr Link2', { appointmentTypeIds: [type.id] });
      await inAlpha((trx) => trx.deleteFrom('provider_appointment_types').where('provider_id', '=', p.id).execute());
      expect((await get<Provider>(`/api/providers/${p.id}`)).appointmentTypeIds).toEqual([]);
    });

    it('isolates every table by practice (row-level security)', async () => {
      for (const table of ['providers', 'appointment_types', 'provider_appointment_types', 'provider_time_off', 'scheduling_settings'] as const) {
        const seen = await inAlpha((trx) => trx.selectFrom(table).select('practice_id').execute());
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((row) => row.practice_id === alpha.practiceId)).toBe(true);
      }
      expect(await appDb.selectFrom('providers').selectAll().execute()).toEqual([]); // no practice, no rows
    });

    it('cannot link a provider to another practice’s appointment type, even with direct database access', async () => {
      const mine = (await owner.selectFrom('providers').select('id').where('practice_id', '=', alpha.practiceId).limit(1).executeTakeFirstOrThrow()).id;
      const theirs = (await owner.selectFrom('appointment_types').select('id').where('practice_id', '=', beta.practiceId).limit(1).executeTakeFirstOrThrow()).id;
      await expect(owner.insertInto('provider_appointment_types').values({ practice_id: alpha.practiceId, provider_id: mine, appointment_type_id: theirs }).execute()).rejects.toThrow(/foreign key/);
      await expect(owner.insertInto('provider_appointment_types').values({ practice_id: beta.practiceId, provider_id: mine, appointment_type_id: theirs }).execute()).rejects.toThrow(/foreign key/);
    });

    it('cannot record time off for another practice’s provider, even with direct database access', async () => {
      const theirs = (await owner.selectFrom('providers').select('id').where('practice_id', '=', beta.practiceId).limit(1).executeTakeFirstOrThrow()).id;
      await expect(
        owner.insertInto('provider_time_off').values({ practice_id: alpha.practiceId, provider_id: theirs, starts_at: new Date('2027-01-01'), ends_at: new Date('2027-01-02') }).execute(),
      ).rejects.toThrow(/foreign key/);
    });

    it.each([
      ['a visit shorter than 5 minutes', () => owner.insertInto('appointment_types').values({ practice_id: alpha.practiceId, name: 'Short', duration_minutes: 4 }).execute()],
      ['a visit longer than 8 hours', () => owner.insertInto('appointment_types').values({ practice_id: alpha.practiceId, name: 'Long', duration_minutes: 481 }).execute()],
      ['a nameless provider', () => owner.insertInto('providers').values({ practice_id: alpha.practiceId, name: '   ' }).execute()],
      ['hours that are not an object', () => owner.insertInto('providers').values({ practice_id: alpha.practiceId, name: 'Bad hours', hours: '[]' as never }).execute()],
      ['time off that ends before it starts', async () => {
        const provider = (await owner.selectFrom('providers').select('id').where('practice_id', '=', alpha.practiceId).limit(1).executeTakeFirstOrThrow()).id;
        await owner.insertInto('provider_time_off').values({ practice_id: alpha.practiceId, provider_id: provider, starts_at: new Date('2027-01-02'), ends_at: new Date('2027-01-01') }).execute();
      }],
      ['a slot length that is not offered', () => owner.insertInto('scheduling_settings').values({ practice_id: beta.practiceId, slot_minutes: 7 }).execute()],
    ])('refuses %s', async (_name, run) => {
      await expect(run()).rejects.toThrow(/check constraint/);
    });
  });
});
