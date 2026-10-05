import { ConflictException } from '@nestjs/common';
import type { Appointment, AppointmentType, AvailabilityResponse, Patient, Provider, ProviderTimeOff, Role } from '@frontdesk/shared';
import { WEEKDAYS } from '@frontdesk/shared';
import type { Db } from '../src/database/database.module.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { AppointmentsService, CancellationWindowError, translateBookingError, type BookInput } from '../src/scheduling/appointments.service.js';
import { startTestApp } from './support/app.js';
import { as, signIn, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const SOME_UUID = '0190ffff-0000-7000-8000-000000000000';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const META = { ip: null, userAgent: null, requestId: null };

/** A Monday at least ten days ahead, midnight UTC (the test practice's clock is UTC). */
function nextMonday(): Date {
  const date = new Date(Date.now() + 10 * DAY);
  date.setUTCHours(0, 0, 0, 0);
  while (date.getUTCDay() !== 1) date.setTime(date.getTime() + DAY);
  return date;
}
const MONDAY = nextMonday();
/** An instant: `daysAfterMonday` days after that Monday, at hh:mm UTC. */
const at = (daysAfterMonday: number, hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(MONDAY.getTime() + daysAfterMonday * DAY + h! * HOUR + m! * 60_000).toISOString();
};
const MON_TO_FRI = Object.fromEntries(WEEKDAYS.map((d) => [d, ['sat', 'sun'].includes(d) ? [] : [{ open: '09:00', close: '12:00' }]]));

let counter = 0;
const unique = () => (counter += 1);
const newKey = () => `key-${unique()}-${Math.random().toString(36).slice(2, 10)}`;

describe('patients and appointments', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let appDb: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  const token: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  let betaToken: string;
  let visit: AppointmentType; // 30 minutes
  let longVisit: AppointmentType; // 60 minutes

  const patientBody = (extra: Partial<Record<string, unknown>> = {}) => {
    const n = unique();
    return { firstName: `Pat${n}`, lastName: `Tester${n}`, dateOfBirth: '1990-05-17', phone: `+1415555${String(1000 + n).padStart(4, '0')}`, ...extra };
  };
  const newPatient = async (extra: Partial<Record<string, unknown>> = {}, t = token.staff) => (await as(app, t).post('/api/patients', patientBody(extra)).expect(201)).body as Patient;
  const newProvider = async (name: string, types: string[] = [visit.id, longVisit.id], hours: object = MON_TO_FRI) =>
    (await as(app, token.admin).post('/api/providers', { name: `${name} ${unique()}`, hours, appointmentTypeIds: types }).expect(201)).body as Provider;
  const bookRequest = (body: object, t = token.staff, key = newKey()) => as(app, t).post('/api/appointments', body).set('Idempotency-Key', key);
  const book = async (patientId: string, providerId: string, startsAt: string, typeId = visit.id) =>
    (await bookRequest({ patientId, providerId, appointmentTypeId: typeId, startsAt }).expect(201)).body as Appointment;
  const get = <T>(path: string, t = token.staff) => as(app, t).get(path).expect(200).then((res) => res.body as T);
  const rules = (body: object) => as(app, token.admin).patch('/api/scheduling/settings', body).expect(200);
  /** Back to the rules every test starts from (set directly: the API refuses a "change" that changes nothing). */
  const resetRules = () =>
    owner.updateTable('scheduling_settings').set({ min_notice_hours: 0, max_advance_days: 365, cancel_min_hours: 24 }).where('practice_id', '=', alpha.practiceId).execute();
  const audit = (action: string) => owner.selectFrom('audit_logs').selectAll().where('action', '=', action).orderBy('occurred_at').execute();
  const rowCount = async (providerId: string, status?: string) => {
    let q = owner.selectFrom('appointments').select((eb) => eb.fn.countAll<string>().as('n')).where('provider_id', '=', providerId);
    if (status) q = q.where('status', '=', status as 'booked');
    return Number((await q.executeTakeFirstOrThrow()).n);
  };
  const slotsOf = async (providerId: string, typeId = visit.id, day = 0) =>
    ((await get<AvailabilityResponse>(`/api/availability?appointmentTypeId=${typeId}&providerId=${providerId}&from=${at(day, '00:00')}&to=${at(day + 1, '00:00')}&limit=100`)).slots).map((s) => s.startsAt.slice(11, 16));

  const service = () => app.get(AppointmentsService);
  const asAi = <T>(work: (trx: Parameters<Parameters<typeof withPracticeContext<T>>[2]>[0]) => Promise<T>) =>
    withPracticeContext(appDb, { practiceId: alpha.practiceId }, work).catch((error: unknown) => {
      throw translateBookingError(error);
    });
  const aiBook = (input: BookInput) => asAi((trx) => service().bookInTransaction(trx, alpha.practiceId, { kind: 'ai' }, input, META, 'caller'));

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
    await rules({ slotMinutes: 30, minNoticeHours: 0, maxAdvanceDays: 365 });
    visit = (await as(app, token.admin).post('/api/appointment-types', { name: 'Visit', durationMinutes: 30 }).expect(201)).body as AppointmentType;
    longVisit = (await as(app, token.admin).post('/api/appointment-types', { name: 'Long visit', durationMinutes: 60 }).expect(201)).body as AppointmentType;
  });

  afterAll(async () => {
    await app.close();
    await appDb.destroy();
    await owner.destroy();
    await database.drop();
  });

  // ------------------------------------------------------------------ access

  describe('who may do what', () => {
    let patient: Patient;
    let appointment: Appointment;
    beforeAll(async () => {
      patient = await newPatient();
      appointment = await book(patient.id, (await newProvider('Dr Access')).id, at(0, '09:00'));
    });

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])('searching and viewing patients as %s -> %i', async (role, status) => {
      await as(app, token[role]).get('/api/patients?q=Pat').expect(status);
      await as(app, token[role]).get(`/api/patients/${patient.id}`).expect(status);
    });

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])('reading the calendar as %s -> %i', async (role, status) => {
      await as(app, token[role]).get(`/api/appointments?from=${at(0, '00:00')}&to=${at(1, '00:00')}`).expect(status);
      await as(app, token[role]).get(`/api/appointments/${appointment.id}`).expect(status);
    });

    it.each<[Role, number]>([['owner', 201], ['admin', 201], ['staff', 201], ['viewer', 403]])('adding a patient as %s -> %i (staff work the desk)', async (role, status) => {
      await as(app, token[role]).post('/api/patients', patientBody()).expect(status);
    });

    it('booking, moving and cancelling are for owners, admins and staff, never viewers', async () => {
      const provider = await newProvider('Dr Roles');
      const body = { patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(1, '09:00') };
      await bookRequest(body, token.viewer).expect(403);
      const mine = (await bookRequest(body, token.staff).expect(201)).body as Appointment;
      await as(app, token.viewer).post(`/api/appointments/${mine.id}/reschedule`, { startsAt: at(1, '10:00') }).set('Idempotency-Key', newKey()).expect(403);
      await as(app, token.viewer).post(`/api/appointments/${mine.id}/cancel`, {}).expect(403);
      await as(app, token.staff).post(`/api/appointments/${mine.id}/cancel`, {}).expect(200);
      const second = (await bookRequest({ ...body, startsAt: at(1, '09:30') }, token.admin).expect(201)).body as Appointment;
      await as(app, token.owner).post(`/api/appointments/${second.id}/cancel`, {}).expect(200);
    });

    it('everything needs a login', async () => {
      await as(app, 'no-token').get('/api/patients?q=Pat').expect(401);
      await as(app, 'no-token').get('/api/appointments').expect(401);
      await as(app, 'no-token').post('/api/appointments', {}).expect(401);
      await as(app, 'no-token').post('/api/patients', {}).expect(401);
    });
  });

  // ---------------------------------------------------------------- patients

  describe('patients', () => {
    it('are added once: the same name (any capitals), birth date and phone returns the same patient', async () => {
      const first = (await as(app, token.staff).post('/api/patients', { firstName: '  Amina ', lastName: 'Khan', dateOfBirth: '1985-03-09', phone: '+923001230001' }).expect(201)).body as Patient;
      expect(first).toMatchObject({ firstName: 'Amina', lastName: 'Khan', dateOfBirth: '1985-03-09', phone: '+923001230001' });
      const again = (await as(app, token.staff).post('/api/patients', { firstName: 'AMINA', lastName: 'khan', dateOfBirth: '1985-03-09', phone: '+923001230001' }).expect(200)).body as Patient;
      expect(again.id).toBe(first.id);
      expect(again.firstName).toBe('Amina'); // the stored record, not the new spelling
      const other = (await as(app, token.staff).post('/api/patients', { firstName: 'Amina', lastName: 'Khan', dateOfBirth: '1985-03-10', phone: '+923001230001' }).expect(201)).body as Patient;
      expect(other.id).not.toBe(first.id);
      const otherPhone = (await as(app, token.staff).post('/api/patients', { firstName: 'Amina', lastName: 'Khan', dateOfBirth: '1985-03-09', phone: '+923001230002' }).expect(201)).body as Patient;
      expect(otherPhone.id).not.toBe(first.id); // same name and birth date, different phone: not the same person
      expect(await owner.selectFrom('patients').select('id').where('last_name', '=', 'Khan').execute()).toHaveLength(3);
    });

    it('adding the same new patient many times at once makes exactly one', async () => {
      const body = patientBody({ lastName: 'Racer' });
      const results = await Promise.all(Array.from({ length: 6 }, () => as(app, token.staff).post('/api/patients', body)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await owner.selectFrom('patients').select('id').where('last_name', '=', 'Racer').execute()).toHaveLength(1);
    });

    it('keep the date of birth exactly as written, whatever the server clock', async () => {
      for (const dateOfBirth of ['1990-01-01', '2000-12-31', '1900-01-01', '2024-02-29']) {
        const created = await newPatient({ dateOfBirth });
        expect(created.dateOfBirth).toBe(dateOfBirth);
        expect((await get<Patient>(`/api/patients/${created.id}`)).dateOfBirth).toBe(dateOfBirth);
        expect((await get<Patient[]>(`/api/patients?q=${created.lastName}`))[0]!.dateOfBirth).toBe(dateOfBirth);
      }
    });

    it.each([
      ['no first name', { firstName: undefined }],
      ['an empty first name', { firstName: '   ' }],
      ['a first name over 100 characters', { firstName: 'x'.repeat(101) }],
      ['a last name over 100 characters', { lastName: 'x'.repeat(101) }],
      ['no date of birth', { dateOfBirth: undefined }],
      ['a date that does not exist', { dateOfBirth: '1990-02-30' }],
      ['a date of birth in the future', { dateOfBirth: '2999-01-01' }],
      ['a date of birth before 1900', { dateOfBirth: '1899-12-31' }],
      ['a date with the wrong shape', { dateOfBirth: '17/05/1990' }],
      ['a phone without the country code', { phone: '03001230001' }],
      ['a phone with spaces', { phone: '+92 300 1230001' }],
      ['a phone that is too short', { phone: '+12345' }],
      ['a phone that is text', { phone: 'call me' }],
      ['an unknown field (a practice cannot be named)', { practiceId: SOME_UUID }],
      ['a created-by field', { createdBy: SOME_UUID }],
    ])('refuses %s', async (_name, extra) => {
      await as(app, token.staff).post('/api/patients', patientBody(extra)).expect(400);
    });

    describe('search', () => {
      let zelda: Patient;
      beforeAll(async () => {
        zelda = await newPatient({ firstName: 'Zelda', lastName: 'Quimby', phone: '+14155550199' });
        await as(app, betaToken).post('/api/patients', { firstName: 'Zelda', lastName: 'Quimby', dateOfBirth: '1990-05-17', phone: '+14155550198' }).expect(201); // same name, another practice
        for (const first of ['Cara', 'Bert', 'Anna']) await newPatient({ firstName: first, lastName: 'Limitson' });
      });
      const search = (q: string, t = token.staff) => as(app, t).get(`/api/patients?q=${encodeURIComponent(q)}`);

      it('finds by the start of a last name, a first name, both, or part of a phone number', async () => {
        for (const q of ['quim', 'QUIMBY', 'zel', 'zelda quimby', 'quimby zel', 'Z Q', '5550199', '+14155550199', '555-0199']) {
          const found = (await search(q).expect(200)).body as Patient[];
          expect(found.map((p) => p.id), q).toEqual([zelda.id]);
        }
      });

      it('shows date of birth and phone, so two people with one name can be told apart', async () => {
        expect(((await search('quimby').expect(200)).body as Patient[])[0]).toMatchObject({ dateOfBirth: '1990-05-17', phone: '+14155550199' });
      });

      it('never shows another practice’s patients', async () => {
        expect(((await search('quimby', betaToken).expect(200)).body as Patient[]).map((p) => p.phone)).toEqual(['+14155550198']);
        expect(((await search('limitson', betaToken).expect(200)).body as Patient[])).toEqual([]);
      });

      it('lists by last name then first name, and honours the limit', async () => {
        expect(((await search('limitson').expect(200)).body as Patient[]).map((p) => p.firstName)).toEqual(['Anna', 'Bert', 'Cara']);
        expect(((await as(app, token.staff).get('/api/patients?q=limitson&limit=2').expect(200)).body as Patient[]).map((p) => p.firstName)).toEqual(['Anna', 'Bert']);
      });

      it('treats % and _ as plain characters, so a search cannot list everyone', async () => {
        for (const q of ['%%', '__', '%a', 'z%', '_elda']) expect(((await search(q).expect(200)).body as Patient[]), q).toEqual([]);
      });

      it.each([
        ['nothing', ''],
        ['one character', 'z'],
        ['only spaces', '   '],
      ])('refuses a search of %s', async (_name, q) => {
        await search(q).expect(400);
      });

      it('refuses a limit that is zero or over 25, and a missing search', async () => {
        await as(app, token.staff).get('/api/patients?q=quimby&limit=0').expect(400);
        await as(app, token.staff).get('/api/patients?q=quimby&limit=26').expect(400);
        await as(app, token.staff).get('/api/patients').expect(400);
      });

      it('is audited by how many patients were shown, never by what was typed or who was found', async () => {
        await search('zelda quimby').expect(200);
        const entry = (await audit('patient.searched')).at(-1)!;
        expect(entry).toMatchObject({ actor_type: 'user', actor_user_id: expect.any(String), metadata: { resultCount: 1 } });
        expect(JSON.stringify(entry)).not.toMatch(/zelda|quimby|555/i);
      });
    });

    it('can be opened by id, which is audited; another practice’s patient or an unknown id is "not found"', async () => {
      const p = await newPatient();
      expect(await get<Patient>(`/api/patients/${p.id}`)).toEqual(p);
      const viewed = (await audit('patient.viewed')).filter((e) => e.target_id === p.id);
      expect(viewed).toHaveLength(1);
      expect(viewed[0]).toMatchObject({ target_type: 'patient', metadata: {} });
      await as(app, betaToken).get(`/api/patients/${p.id}`).expect(404);
      await as(app, token.staff).get(`/api/patients/${SOME_UUID}`).expect(404);
      await as(app, token.staff).get('/api/patients/not-a-uuid').expect(400);
      expect((await audit('patient.viewed')).filter((e) => e.target_id === p.id)).toHaveLength(1); // the failed attempts left nothing
    });

    it('creating a patient is audited with the source only, never the name, birth date or phone', async () => {
      const p = await newPatient({ firstName: 'Auditee', lastName: 'Secretname', phone: '+14155559999' });
      const entry = (await audit('patient.created')).find((e) => e.target_id === p.id)!;
      expect(entry).toMatchObject({ actor_type: 'user', metadata: { source: 'user' } });
      expect(JSON.stringify(entry)).not.toMatch(/auditee|secretname|5559999|1990/i);
    });
  });

  // ------------------------------------------------------------------ booking

  describe('booking', () => {
    it('books an offered time, records who and what, and removes that time from the offers', async () => {
      const provider = await newProvider('Dr Book');
      const patient = await newPatient();
      expect(await slotsOf(provider.id)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
      const booked = await book(patient.id, provider.id, at(0, '10:00'));
      expect(booked).toMatchObject({
        patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName },
        providerId: provider.id,
        providerName: provider.name,
        appointmentTypeId: visit.id,
        appointmentTypeName: 'Visit',
        startsAt: at(0, '10:00'),
        endsAt: at(0, '10:30'),
        status: 'booked',
        bookedBy: 'user',
        cancelledAt: null,
        cancelReason: '',
        rescheduledFromId: null,
      });
      expect(await slotsOf(provider.id)).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
      const stored = await owner.selectFrom('appointments').selectAll().where('id', '=', booked.id).executeTakeFirstOrThrow();
      expect(stored).toMatchObject({ booked_by_type: 'user', booked_by: expect.any(String), practice_id: alpha.practiceId });
    });

    it('a longer visit blocks every slot it covers', async () => {
      const provider = await newProvider('Dr Long');
      const patient = await newPatient();
      await book(patient.id, provider.id, at(0, '09:30'), longVisit.id); // 09:30 to 10:30
      expect(await slotsOf(provider.id)).toEqual(['09:00', '10:30', '11:00', '11:30']);
      expect(await slotsOf(provider.id, longVisit.id)).toEqual(['10:30', '11:00']);
    });

    it('a time that was just taken is refused for the next person, who can book the next time', async () => {
      const provider = await newProvider('Dr Taken');
      const [a, b] = [await newPatient(), await newPatient()];
      await book(a.id, provider.id, at(0, '09:00'));
      const res = await bookRequest({ patientId: b.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') }).expect(409);
      expect(res.body.message).toBe('That time is not available');
      await book(b.id, provider.id, at(0, '09:30'));
      expect(await rowCount(provider.id, 'booked')).toBe(2);
    });

    it('a visit that would run into a booked time just past the end of the search is not offered', async () => {
      const provider = await newProvider('Dr Edge');
      await book((await newPatient()).id, provider.id, at(0, '10:00')); // 10:00 to 10:30
      const res = await get<AvailabilityResponse>(`/api/availability?appointmentTypeId=${longVisit.id}&providerId=${provider.id}&from=${at(0, '00:00')}&to=${at(0, '10:00')}`);
      expect(res.slots.map((s) => s.startsAt.slice(11, 16))).toEqual(['09:00']); // 09:30 to 10:30 would overlap the 10:00 visit, though it starts before the search ends
    });

    it('two providers can be booked at the same time', async () => {
      const [p1, p2] = [await newProvider('Dr One'), await newProvider('Dr Two')];
      await book((await newPatient()).id, p1.id, at(0, '09:00'));
      await book((await newPatient()).id, p2.id, at(0, '09:00'));
    });

    it('one patient cannot be booked in two places at once, but can have back-to-back visits', async () => {
      const [p1, p2] = [await newProvider('Dr Left'), await newProvider('Dr Right')];
      const patient = await newPatient();
      await book(patient.id, p1.id, at(0, '09:00'));
      const res = await bookRequest({ patientId: patient.id, providerId: p2.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') }).expect(409);
      expect(res.body.message).toBe('The patient already has an appointment at that time');
      await book(patient.id, p2.id, at(0, '09:30')); // starts exactly when the other ends
    });

    it('many callers booking the same time at once end with exactly one appointment', async () => {
      const provider = await newProvider('Dr Rush');
      const patients = await Promise.all(Array.from({ length: 8 }, () => newPatient()));
      const results = await Promise.all(
        patients.map((p) => bookRequest({ patientId: p.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '11:00') })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      expect(results.filter((r) => r.status === 409).every((r) => ['That time was just taken', 'That time is not available'].includes(r.body.message))).toBe(true);
      expect(await rowCount(provider.id, 'booked')).toBe(1);
    });

    describe('retries (idempotency)', () => {
      it('the same key and request again returns the same appointment (200), and books once', async () => {
        const provider = await newProvider('Dr Retry');
        const patient = await newPatient();
        const key = newKey();
        const body = { patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') };
        const first = (await bookRequest(body, token.staff, key).expect(201)).body as Appointment;
        const second = (await bookRequest(body, token.staff, key).expect(200)).body as Appointment;
        expect(second).toEqual(first);
        expect(await rowCount(provider.id)).toBe(1);
        expect((await audit('appointment.booked')).filter((e) => e.target_id === first.id)).toHaveLength(1); // one booking, one audit entry
      });

      it('the same request sent many times at once books once', async () => {
        const provider = await newProvider('Dr Parallel');
        const patient = await newPatient();
        const key = newKey();
        const body = { patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '10:00') };
        const results = await Promise.all(Array.from({ length: 6 }, () => bookRequest(body, token.staff, key)));
        expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
        expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
        expect(await rowCount(provider.id)).toBe(1);
      });

      it('the same key for a different request is refused, not answered with someone else’s appointment', async () => {
        const provider = await newProvider('Dr Reuse');
        const [a, b] = [await newPatient(), await newPatient()];
        const key = newKey();
        await bookRequest({ patientId: a.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') }, token.staff, key).expect(201);
        const otherProvider = await newProvider('Dr Reuse2');
        for (const body of [
          { patientId: b.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') },
          { patientId: a.id, providerId: otherProvider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') },
          { patientId: a.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:30') },
          { patientId: a.id, providerId: provider.id, appointmentTypeId: longVisit.id, startsAt: at(0, '09:00') },
        ]) {
          const res = await bookRequest(body, token.staff, key).expect(409);
          expect(res.body.message).toBe('That idempotency key was already used for a different request');
        }
        expect(await rowCount(provider.id)).toBe(1);
      });

      it('keys belong to one practice: another practice may use the same key', async () => {
        const key = newKey();
        const provider = await newProvider('Dr Keys');
        await bookRequest({ patientId: (await newPatient()).id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') }, token.staff, key).expect(201);
        const betaType = (await as(app, betaToken).post('/api/appointment-types', { name: 'Visit', durationMinutes: 30 }).expect(201)).body as AppointmentType;
        const betaProvider = (await as(app, betaToken).post('/api/providers', { name: 'Dr Beta', hours: MON_TO_FRI, appointmentTypeIds: [betaType.id] }).expect(201)).body as Provider;
        await as(app, betaToken).patch('/api/scheduling/settings', { slotMinutes: 30, minNoticeHours: 0 }).expect(200);
        const betaPatient = (await as(app, betaToken).post('/api/patients', patientBody()).expect(201)).body as Patient;
        await as(app, betaToken)
          .post('/api/appointments', { patientId: betaPatient.id, providerId: betaProvider.id, appointmentTypeId: betaType.id, startsAt: at(0, '09:00') })
          .set('Idempotency-Key', key)
          .expect(201);
      });

      it.each([
        ['missing', undefined],
        ['too short', 'abc'],
        ['too long', 'k'.repeat(101)],
        ['with spaces', 'has some spaces here'],
        ['with odd characters', 'key-with-ünïcode-1'],
      ])('refuses a key that is %s', async (_name, key) => {
        const provider = await newProvider('Dr Key');
        let req = as(app, token.staff).post('/api/appointments', { patientId: SOME_UUID, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') });
        if (key !== undefined) req = req.set('Idempotency-Key', key);
        await req.expect(400);
      });
    });

    describe('times that cannot be booked', () => {
      let provider: Provider;
      let patient: Patient;
      beforeAll(async () => {
        provider = await newProvider('Dr Rules');
        patient = await newPatient();
      });
      const attempt = (startsAt: string, extra: object = {}) => bookRequest({ patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt, ...extra });

      it.each([
        ['before opening', '08:30'],
        ['after closing', '12:00'],
        ['too late to finish before closing', '11:45'],
        ['off the slot grid', '09:10'],
        ['in the lunch gap of nothing: just after the last start', '12:30'],
      ])('refuses a time %s', async (_name, time) => {
        expect((await attempt(at(0, time)).expect(409)).body.message).toBe('That time is not available');
      });

      it('refuses a weekend (no hours) and a time in the past', async () => {
        await attempt(at(5, '09:00')).expect(409);
        await attempt(new Date(Date.now() - DAY).toISOString()).expect(409);
        await attempt(at(-28, '09:00')).expect(409); // a Monday four weeks back at 09:00: inside the hours and on the grid, but over
        await attempt(new Date(Date.now() - 5 * 60_000).toISOString()).expect(409);
      });

      it('refuses a time covered by days off, and allows it again once the days off are cancelled', async () => {
        const off = (await as(app, token.admin).post(`/api/providers/${provider.id}/time-off`, { startsAt: at(1, '10:00'), endsAt: at(1, '11:00') }).expect(201)).body as ProviderTimeOff;
        await attempt(at(1, '10:30')).expect(409);
        await attempt(at(1, '09:30')).expect(201); // ends exactly when the time off starts... 09:30 to 10:00
        await as(app, token.admin).post(`/api/provider-time-off/${off.id}/cancel`).expect(200);
        await attempt(at(1, '10:30')).expect(201);
      });

      it('refuses a switched-off provider or visit type, and a provider who does not offer the visit', async () => {
        const off = await newProvider('Dr Off');
        await as(app, token.admin).patch(`/api/providers/${off.id}`, { active: false }).expect(200);
        await bookRequest({ patientId: patient.id, providerId: off.id, appointmentTypeId: visit.id, startsAt: at(2, '09:00') }).expect(404);

        const retired = (await as(app, token.admin).post('/api/appointment-types', { name: `Retired ${unique()}`, durationMinutes: 30, providerIds: [provider.id] }).expect(201)).body as AppointmentType;
        await as(app, token.admin).patch(`/api/appointment-types/${retired.id}`, { active: false }).expect(200);
        await attempt(at(2, '09:00'), { appointmentTypeId: retired.id }).expect(404);

        const shortList = await newProvider('Dr Only Long', [longVisit.id]);
        const res = await bookRequest({ patientId: patient.id, providerId: shortList.id, appointmentTypeId: visit.id, startsAt: at(2, '09:00') }).expect(400);
        expect(res.body.message).toBe('That provider does not offer this appointment type');
      });

      it('refuses unknown or other practices’ patients, providers and visit types as "not found"', async () => {
        await attempt(at(2, '09:00'), { patientId: SOME_UUID }).expect(404);
        await attempt(at(2, '09:00'), { providerId: SOME_UUID }).expect(404);
        await attempt(at(2, '09:00'), { appointmentTypeId: SOME_UUID }).expect(404);
        const betaPatient = (await as(app, betaToken).post('/api/patients', patientBody()).expect(201)).body as Patient;
        await attempt(at(2, '09:00'), { patientId: betaPatient.id }).expect(404);
        await as(app, betaToken)
          .post('/api/appointments', { patientId: betaPatient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(2, '09:00') })
          .set('Idempotency-Key', newKey())
          .expect(404); // and another practice cannot book into this practice's provider
      });

      it.each([
        ['no patient', { patientId: undefined }],
        ['a patient that is not a UUID', { patientId: 'pat' }],
        ['no start time', { startsAt: undefined }],
        ['a start time that is not a time', { startsAt: 'tomorrow morning' }],
        ['an unknown field (the status cannot be chosen)', { status: 'completed' }],
        ['an unknown field (the end cannot be chosen)', { endsAt: at(2, '12:00') }],
        ['an unknown field (a practice cannot be named)', { practiceId: SOME_UUID }],
      ])('refuses %s', async (_name, extra) => {
        await attempt(at(2, '09:00'), extra).expect(400);
      });
    });

    describe('the practice’s booking rules apply to callers, not to the front desk', () => {
      let provider: Provider;
      let patient: Patient;
      beforeAll(async () => {
        provider = await newProvider('Dr Notice');
        patient = await newPatient();
      });
      afterEach(resetRules);
      const input = (day: number, time: string): BookInput => ({ patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: new Date(at(day, time)), idempotencyKey: newKey() });

      it('minimum notice: staff may book short notice, a caller may not', async () => {
        await rules({ minNoticeHours: 720 }); // 30 days; the test Monday is 10 to 17 days away
        expect(await slotsOf(provider.id)).toEqual([]);
        await expect(aiBook(input(0, '09:00'))).rejects.toThrow('That time is not available');
        await bookRequest({ patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') }).expect(201);
      });

      it('furthest ahead: staff may book further out, a caller may not', async () => {
        await rules({ maxAdvanceDays: 5 });
        await expect(aiBook(input(14, '09:00'))).rejects.toThrow('That time is not available');
        await bookRequest({ patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(14, '09:00') }).expect(201);
      });

      it('staff are still limited to a year ahead, and the AI books with the same rules when they allow it', async () => {
        await bookRequest({ patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(7 * 60, '09:00') }).expect(409); // 420 days out
        const { appointmentId } = await aiBook(input(21, '09:00'));
        const row = await owner.selectFrom('appointments').selectAll().where('id', '=', appointmentId).executeTakeFirstOrThrow();
        expect(row).toMatchObject({ booked_by_type: 'ai', booked_by: null });
      });
    });

    it('is audited with identifiers only, as the person who booked', async () => {
      const provider = await newProvider('Dr Audit');
      const patient = await newPatient({ firstName: 'Hidden', lastName: 'Personname' });
      const booked = await book(patient.id, provider.id, at(0, '09:00'));
      const entry = (await audit('appointment.booked')).find((e) => e.target_id === booked.id)!;
      expect(entry).toMatchObject({
        actor_type: 'user',
        actor_user_id: expect.any(String),
        target_type: 'appointment',
        metadata: { patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, source: 'user' },
      });
      expect(Object.keys(entry.metadata as object).sort()).toEqual(['appointmentTypeId', 'patientId', 'providerId', 'source']);
      expect(JSON.stringify(entry)).not.toMatch(/hidden|personname|1990-05-17|\+1415555/i);
    });

    it('a refused booking leaves no appointment and no audit entry', async () => {
      const provider = await newProvider('Dr Refused');
      const before = (await audit('appointment.booked')).length;
      await bookRequest({ patientId: (await newPatient()).id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '08:00') }).expect(409);
      expect(await rowCount(provider.id)).toBe(0);
      expect((await audit('appointment.booked')).length).toBe(before);
    });
  });

  // ------------------------------------------------------------------ cancel

  describe('cancelling', () => {
    it('frees the time, keeps the record, and says who and why', async () => {
      const provider = await newProvider('Dr Cancel');
      const patient = await newPatient();
      const booked = await book(patient.id, provider.id, at(0, '09:00'));
      const cancelled = (await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, { reason: '  Patient called  ' }).expect(200)).body as Appointment;
      expect(cancelled).toMatchObject({ id: booked.id, status: 'cancelled', cancelReason: 'Patient called', cancelledAt: expect.any(String) });
      expect(await slotsOf(provider.id)).toContain('09:00');
      const row = await owner.selectFrom('appointments').selectAll().where('id', '=', booked.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'cancelled', cancelled_by_type: 'user', cancelled_by: expect.any(String) });
      // the freed time can be booked again, by the same patient or another
      await book((await newPatient()).id, provider.id, at(0, '09:00'));
      await book(patient.id, provider.id, at(0, '09:30'));
      expect(await rowCount(provider.id)).toBe(3);
    });

    it('cancelling needs no reason, and a second cancel is refused', async () => {
      const provider = await newProvider('Dr Twice');
      const booked = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      expect(((await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, {}).expect(200)).body as Appointment).cancelReason).toBe('');
      const again = await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, {}).expect(409);
      expect(again.body.message).toBe('Already cancelled');
    });

    it('only a booked appointment can be cancelled', async () => {
      const provider = await newProvider('Dr Done');
      const booked = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      await owner.updateTable('appointments').set({ status: 'completed' }).where('id', '=', booked.id).execute();
      await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, {}).expect(409);
    });

    it('unknown and other practices’ appointments are "not found"; a reason over 200 characters is refused', async () => {
      const provider = await newProvider('Dr Hidden');
      const booked = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      await as(app, token.staff).post(`/api/appointments/${SOME_UUID}/cancel`, {}).expect(404);
      await as(app, betaToken).post(`/api/appointments/${booked.id}/cancel`, {}).expect(404);
      await as(app, betaToken).get(`/api/appointments/${booked.id}`).expect(404);
      await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, { reason: 'x'.repeat(201) }).expect(400);
      await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, { status: 'booked' }).expect(400);
      expect((await get<Appointment>(`/api/appointments/${booked.id}`)).status).toBe('booked'); // none of that changed anything
    });

    it('a repeated booking request after the appointment was cancelled shows it as cancelled, not as a new booking', async () => {
      const provider = await newProvider('Dr Replay');
      const patient = await newPatient();
      const key = newKey();
      const body = { patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: at(0, '09:00') };
      const booked = (await bookRequest(body, token.staff, key).expect(201)).body as Appointment;
      await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, {}).expect(200);
      const replay = (await bookRequest(body, token.staff, key).expect(200)).body as Appointment;
      expect(replay).toMatchObject({ id: booked.id, status: 'cancelled' });
    });

    it('is audited with identifiers only, never the reason', async () => {
      const provider = await newProvider('Dr Audit2');
      const patient = await newPatient();
      const booked = await book(patient.id, provider.id, at(0, '09:00'));
      await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, { reason: 'Secret family matter' }).expect(200);
      const entry = (await audit('appointment.cancelled')).find((e) => e.target_id === booked.id)!;
      expect(entry).toMatchObject({ actor_type: 'user', metadata: { patientId: patient.id, providerId: provider.id, source: 'user' } });
      expect(JSON.stringify(entry)).not.toMatch(/secret/i);
    });
  });

  // -------------------------------------------------------------- reschedule

  describe('rescheduling', () => {
    const move = (id: string, body: object, key = newKey(), t = token.staff) => as(app, t).post(`/api/appointments/${id}/reschedule`, body).set('Idempotency-Key', key);

    it('books the new time and releases the old one together, and links them', async () => {
      const provider = await newProvider('Dr Move');
      const patient = await newPatient();
      const old = await book(patient.id, provider.id, at(0, '09:00'));
      const moved = (await move(old.id, { startsAt: at(0, '11:00') }).expect(201)).body as Appointment;
      expect(moved).toMatchObject({ status: 'booked', startsAt: at(0, '11:00'), endsAt: at(0, '11:30'), rescheduledFromId: old.id, providerId: provider.id, appointmentTypeId: visit.id, patient: { id: patient.id } });
      expect(moved.id).not.toBe(old.id);
      expect(await get<Appointment>(`/api/appointments/${old.id}`)).toMatchObject({ status: 'cancelled', cancelReason: 'Rescheduled' });
      expect(await slotsOf(provider.id)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:30']);
    });

    it('can move to a time that overlaps the old one (the old time is released first)', async () => {
      const provider = await newProvider('Dr Overlap');
      const patient = await newPatient();
      const old = await book(patient.id, provider.id, at(0, '09:00'), longVisit.id); // 09:00 to 10:00
      const moved = (await move(old.id, { startsAt: at(0, '09:30') }).expect(201)).body as Appointment; // 09:30 to 10:30
      expect(moved).toMatchObject({ startsAt: at(0, '09:30'), endsAt: at(0, '10:30'), appointmentTypeId: longVisit.id });
    });

    it('can move to another provider who offers the same visit, and not to one who does not', async () => {
      const [p1, p2] = [await newProvider('Dr From'), await newProvider('Dr To')];
      const only = await newProvider('Dr Only Long', [longVisit.id]);
      const old = await book((await newPatient()).id, p1.id, at(0, '09:00'));
      await move(old.id, { startsAt: at(0, '09:00'), providerId: only.id }).expect(400);
      expect((await get<Appointment>(`/api/appointments/${old.id}`)).status).toBe('booked');
      const moved = (await move(old.id, { startsAt: at(0, '09:00'), providerId: p2.id }).expect(201)).body as Appointment;
      expect(moved).toMatchObject({ providerId: p2.id, startsAt: at(0, '09:00') });
    });

    it('a move to a taken time changes nothing: the old appointment stays booked', async () => {
      const provider = await newProvider('Dr Atomic');
      const [a, b] = [await newPatient(), await newPatient()];
      const mine = await book(a.id, provider.id, at(0, '09:00'));
      await book(b.id, provider.id, at(0, '10:00'));
      const res = await move(mine.id, { startsAt: at(0, '10:00') }).expect(409);
      expect(res.body.message).toBe('That time is not available');
      expect(await get<Appointment>(`/api/appointments/${mine.id}`)).toMatchObject({ status: 'booked', cancelledAt: null });
      expect(await rowCount(provider.id)).toBe(2);
      expect((await audit('appointment.rescheduled')).filter((e) => (e.metadata as { fromAppointmentId?: string }).fromAppointmentId === mine.id)).toEqual([]);
    });

    it('refuses a move to the same time with the same provider, and to a time that is not offered', async () => {
      const provider = await newProvider('Dr Same');
      const old = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      expect((await move(old.id, { startsAt: at(0, '09:00') }).expect(400)).body.message).toBe('Choose a different time or provider');
      await move(old.id, { startsAt: at(0, '08:00') }).expect(409);
      await move(old.id, { startsAt: at(5, '09:00') }).expect(409); // a Saturday
      expect((await get<Appointment>(`/api/appointments/${old.id}`)).status).toBe('booked');
    });

    it('refuses to move an appointment that is cancelled, unknown, or another practice’s', async () => {
      const provider = await newProvider('Dr Gone');
      const old = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      await move(SOME_UUID, { startsAt: at(0, '10:00') }).expect(404);
      await move(old.id, { startsAt: at(0, '10:00') }, newKey(), betaToken).expect(404);
      await as(app, token.staff).post(`/api/appointments/${old.id}/cancel`, {}).expect(200);
      await move(old.id, { startsAt: at(0, '10:00') }).expect(409);
    });

    it('a repeated request with the same key moves once; a different request with that key is refused', async () => {
      const provider = await newProvider('Dr Idem');
      const old = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      const key = newKey();
      const first = (await move(old.id, { startsAt: at(0, '10:00') }, key).expect(201)).body as Appointment;
      const second = (await move(old.id, { startsAt: at(0, '10:00') }, key).expect(200)).body as Appointment;
      expect(second).toEqual(first);
      expect(await rowCount(provider.id)).toBe(2);
      expect((await move(old.id, { startsAt: at(0, '11:00') }, key).expect(409)).body.message).toBe('That idempotency key was already used for a different request');
      // a key from an ordinary booking cannot be reused to "move" something else
      const other = await book((await newPatient()).id, provider.id, at(0, '11:00'));
      const bookingKey = (await owner.selectFrom('appointments').select('idempotency_key').where('id', '=', other.id).executeTakeFirstOrThrow()).idempotency_key;
      // (to the very time that booking has, so only the "who made this key" check can refuse it)
      expect((await move(first.id, { startsAt: at(0, '11:00') }, bookingKey).expect(409)).body.message).toBe('That idempotency key was already used for a different request');
    });

    it('a key used for a move cannot be reused to book', async () => {
      const provider = await newProvider('Dr Keyswap');
      const patient = await newPatient();
      const old = await book(patient.id, provider.id, at(0, '09:00'));
      const key = newKey();
      const moved = (await move(old.id, { startsAt: at(0, '10:00') }, key).expect(201)).body as Appointment;
      // the same patient, provider, visit and time as the move produced, with the move's key
      const res = await bookRequest({ patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: moved.startsAt }, token.staff, key).expect(409);
      expect(res.body.message).toBe('That idempotency key was already used for a different request');
    });

    it('two moves of the same appointment at once: exactly one wins', async () => {
      const provider = await newProvider('Dr Race');
      const old = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      const results = await Promise.all([move(old.id, { startsAt: at(0, '10:00') }), move(old.id, { startsAt: at(0, '11:00') })]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await rowCount(provider.id, 'booked')).toBe(1);
      expect(await rowCount(provider.id, 'cancelled')).toBe(1);
    });

    it('is audited as one event with identifiers only', async () => {
      const provider = await newProvider('Dr Audit3');
      const patient = await newPatient();
      const old = await book(patient.id, provider.id, at(0, '09:00'));
      const moved = (await move(old.id, { startsAt: at(0, '10:00') }).expect(201)).body as Appointment;
      const entry = (await audit('appointment.rescheduled')).find((e) => e.target_id === moved.id)!;
      expect(entry).toMatchObject({ actor_type: 'user', metadata: { fromAppointmentId: old.id, patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, source: 'user' } });
      expect((await audit('appointment.cancelled')).filter((e) => e.target_id === old.id)).toEqual([]); // the move is one event, not a cancel plus a booking
    });

    it.each([
      ['no start time', {}],
      ['a start time that is not a time', { startsAt: 'later' }],
      ['an unknown field (the visit type cannot change)', { startsAt: at(0, '10:00'), appointmentTypeId: SOME_UUID }],
      ['an unknown field (the patient cannot change)', { startsAt: at(0, '10:00'), patientId: SOME_UUID }],
    ])('refuses %s', async (_name, body) => {
      const provider = await newProvider('Dr Bad');
      const old = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      await move(old.id, body).expect(400);
    });

    it('refuses a request without a valid Idempotency-Key', async () => {
      const provider = await newProvider('Dr Nokey');
      const old = await book((await newPatient()).id, provider.id, at(0, '09:00'));
      await as(app, token.staff).post(`/api/appointments/${old.id}/reschedule`, { startsAt: at(0, '10:00') }).expect(400);
      await move(old.id, { startsAt: at(0, '10:00') }, 'short').expect(400);
    });
  });

  // -------------------------------------------------------------------- list

  describe('the calendar', () => {
    let provider: Provider;
    let other: Provider;
    let patient: Patient;
    let booked: Appointment[];
    let cancelled: Appointment;
    beforeAll(async () => {
      provider = await newProvider('Dr Calendar');
      other = await newProvider('Dr Elsewhere');
      patient = await newPatient();
      const stranger = await newPatient();
      booked = [
        await book(patient.id, provider.id, at(2, '10:00')),
        await book(stranger.id, provider.id, at(2, '09:00')),
        await book(stranger.id, other.id, at(3, '09:00')),
        await book(patient.id, provider.id, at(4, '09:00')),
      ];
      cancelled = await book(patient.id, provider.id, at(2, '11:00'));
      await as(app, token.staff).post(`/api/appointments/${cancelled.id}/cancel`, {}).expect(200);
    });
    const list = async (query: string) => get<Appointment[]>(`/api/appointments?${query}`);
    const mine = (rows: Appointment[]) => rows.filter((a) => [provider.id, other.id].includes(a.providerId));

    it('lists booked appointments in a window, earliest first, without personal details beyond the name', async () => {
      const rows = mine(await list(`from=${at(2, '00:00')}&to=${at(5, '00:00')}`));
      expect(rows.map((a) => a.startsAt)).toEqual([at(2, '09:00'), at(2, '10:00'), at(3, '09:00'), at(4, '09:00')]);
      expect(rows.every((a) => a.status === 'booked')).toBe(true);
      expect(Object.keys(rows[0]!.patient).sort()).toEqual(['firstName', 'id', 'lastName']);
      expect(JSON.stringify(rows)).not.toMatch(/1990-05-17|\+1415555/);
    });

    it('includes an appointment that is already under way when the window starts, and excludes one that ends exactly at its start', async () => {
      expect(mine(await list(`from=${at(2, '09:15')}&to=${at(2, '09:45')}`)).map((a) => a.startsAt)).toEqual([at(2, '09:00')]);
      expect(mine(await list(`from=${at(2, '09:30')}&to=${at(2, '09:45')}`))).toEqual([]);
      expect(mine(await list(`from=${at(2, '10:00')}&to=${at(2, '10:01')}`)).map((a) => a.startsAt)).toEqual([at(2, '10:00')]);
      expect(mine(await list(`from=${at(2, '09:00')}&to=${at(2, '10:00')}`)).map((a) => a.startsAt)).toEqual([at(2, '09:00')]);
    });

    it('shows cancelled appointments only when asked', async () => {
      expect(mine(await list(`from=${at(2, '00:00')}&to=${at(3, '00:00')}`)).map((a) => a.id)).not.toContain(cancelled.id);
      expect(mine(await list(`from=${at(2, '00:00')}&to=${at(3, '00:00')}&status=all`)).map((a) => a.id)).toContain(cancelled.id);
      expect(mine(await list(`from=${at(2, '00:00')}&to=${at(3, '00:00')}&status=cancelled`)).map((a) => a.id)).toEqual([cancelled.id]);
    });

    it('can be narrowed to one provider or one patient', async () => {
      expect((await list(`from=${at(2, '00:00')}&to=${at(5, '00:00')}&providerId=${other.id}`)).map((a) => a.id)).toEqual([booked[2]!.id]);
      expect((await list(`from=${at(2, '00:00')}&to=${at(5, '00:00')}&patientId=${patient.id}`)).map((a) => a.id)).toEqual([booked[0]!.id, booked[3]!.id]);
    });

    it('honours the limit and defaults to the next seven days', async () => {
      expect(await list(`from=${at(2, '00:00')}&to=${at(5, '00:00')}&providerId=${provider.id}&limit=2`)).toHaveLength(2);
      const soon = await list('');
      expect(soon.every((a) => new Date(a.endsAt).getTime() > Date.now() && new Date(a.startsAt).getTime() < Date.now() + 7 * DAY)).toBe(true);
    });

    it('never shows another practice’s appointments', async () => {
      const seen = await as(app, betaToken).get(`/api/appointments?from=${at(0, '00:00')}&to=${at(30, '00:00')}&status=all`).expect(200).then((r) => r.body as Appointment[]);
      expect(seen.length).toBeGreaterThan(0); // beta has its own appointment...
      expect(seen.every((a) => a.providerName === 'Dr Beta')).toBe(true); // ...and none of alpha's
      expect(seen.map((a) => a.id)).not.toContain(booked[0]!.id);
    });

    it.each([
      ['an end before the start', `from=${at(3, '00:00')}&to=${at(2, '00:00')}`],
      ['a window over 62 days', `from=${at(0, '00:00')}&to=${at(70, '00:00')}`],
      ['dates that are not dates', 'from=monday&to=friday'],
      ['an unknown status', 'status=maybe'],
      ['a limit of zero', 'limit=0'],
      ['a limit over 500', 'limit=501'],
      ['a provider that is not a UUID', 'providerId=dr'],
    ])('refuses %s', async (_name, query) => {
      await as(app, token.staff).get(`/api/appointments?${query}`).expect(400);
    });

    it('opens one appointment by id, and refuses a malformed id', async () => {
      expect(await get<Appointment>(`/api/appointments/${booked[0]!.id}`)).toEqual(booked[0]);
      await as(app, token.staff).get(`/api/appointments/${SOME_UUID}`).expect(404);
      await as(app, token.staff).get('/api/appointments/not-a-uuid').expect(400);
    });
  });

  // ------------------------------------- the AI receptionist's side of the rules

  describe('when the AI receptionist books for a caller', () => {
    afterEach(resetRules);
    const aiCancel = (id: string) =>
      asAi((trx) => service().cancelInTransaction(trx, alpha.practiceId, { kind: 'ai' }, id, 'Caller asked', META, 'caller'));
    const aiMove = (id: string, startsAt: string) =>
      asAi((trx) => service().rescheduleInTransaction(trx, alpha.practiceId, { kind: 'ai' }, id, { startsAt: new Date(startsAt), idempotencyKey: newKey() }, META, 'caller'));

    it('books under its own name in the audit log, never as a person', async () => {
      const provider = await newProvider('Dr AI');
      const patient = await newPatient();
      const { appointmentId, replayed } = await aiBook({ patientId: patient.id, providerId: provider.id, appointmentTypeId: visit.id, startsAt: new Date(at(1, '09:00')), idempotencyKey: newKey() });
      expect(replayed).toBe(false);
      const entry = (await audit('appointment.booked')).find((e) => e.target_id === appointmentId)!;
      expect(entry).toMatchObject({ actor_type: 'ai', actor_user_id: null, metadata: { source: 'ai' } });
      expect((await get<Appointment>(`/api/appointments/${appointmentId}`)).bookedBy).toBe('ai');
    });

    it('a double booking is refused by the database even when the code check is skipped', async () => {
      const provider = await newProvider('Dr Skip');
      const [a, b] = [await newPatient(), await newPatient()];
      await book(a.id, provider.id, at(1, '09:00'));
      // Insert directly, the way a bug or a race would, bypassing every check in code.
      const direct = withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) =>
        trx
          .insertInto('appointments')
          .values({
            practice_id: alpha.practiceId,
            patient_id: b.id,
            provider_id: provider.id,
            appointment_type_id: visit.id,
            starts_at: new Date(at(1, '09:15')),
            ends_at: new Date(at(1, '09:45')),
            booked_by_type: 'ai',
            booked_by: null,
            rescheduled_from_id: null,
            idempotency_key: newKey(),
            cancelled_at: null,
            cancelled_by_type: null,
            cancelled_by: null,
          })
          .execute(),
      );
      await expect(direct).rejects.toThrow(/appointments_provider_no_overlap/);
      await expect(direct.catch((e: unknown) => Promise.reject(translateBookingError(e)))).rejects.toBeInstanceOf(ConflictException);
    });

    it('will not cancel or move an appointment inside the cancellation window, and says so in a way the AI can recognise', async () => {
      const provider = await newProvider('Dr Window');
      const booked = await book((await newPatient()).id, provider.id, at(1, '09:00'));
      await rules({ cancelMinHours: 720 }); // 30 days; the appointment is 11 to 18 days away
      await expect(aiCancel(booked.id)).rejects.toBeInstanceOf(CancellationWindowError);
      await expect(aiMove(booked.id, at(1, '10:00'))).rejects.toBeInstanceOf(CancellationWindowError);
      expect((await get<Appointment>(`/api/appointments/${booked.id}`)).status).toBe('booked');
      // the front desk is not held to the caller's window
      await as(app, token.staff).post(`/api/appointments/${booked.id}/cancel`, {}).expect(200);
    });

    it('cancels and moves outside the window, under its own name', async () => {
      const provider = await newProvider('Dr Outside');
      const booked = await book((await newPatient()).id, provider.id, at(1, '09:00'));
      const moved = await aiMove(booked.id, at(1, '10:00'));
      expect(moved.replayed).toBe(false);
      const entry = (await audit('appointment.rescheduled')).find((e) => e.target_id === moved.appointmentId)!;
      expect(entry).toMatchObject({ actor_type: 'ai', actor_user_id: null });
      await aiCancel(moved.appointmentId);
      const row = await owner.selectFrom('appointments').selectAll().where('id', '=', moved.appointmentId).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'cancelled', cancelled_by_type: 'ai', cancelled_by: null });
      expect((await audit('appointment.cancelled')).find((e) => e.target_id === moved.appointmentId)).toMatchObject({ actor_type: 'ai', actor_user_id: null });
    });

    it('will not cancel an appointment that has already started or passed', async () => {
      const provider = await newProvider('Dr Past');
      const booked = await book((await newPatient()).id, provider.id, at(1, '09:00'));
      await owner.updateTable('appointments').set({ starts_at: new Date(Date.now() - 2 * HOUR), ends_at: new Date(Date.now() - HOUR) }).where('id', '=', booked.id).execute();
      await expect(aiCancel(booked.id)).rejects.toBeInstanceOf(CancellationWindowError);
    });
  });

  // ---------------------------------------------------------- database rules

  describe('the database enforces its own rules', () => {
    let providerId: string;
    let patientId: string;
    const row = (overrides: Record<string, unknown> = {}) => ({
      practice_id: alpha.practiceId,
      patient_id: patientId,
      provider_id: providerId,
      appointment_type_id: visit.id,
      starts_at: new Date(at(30, '09:00')),
      ends_at: new Date(at(30, '09:30')),
      booked_by_type: 'ai' as const,
      booked_by: null,
      rescheduled_from_id: null,
      idempotency_key: newKey(),
      cancelled_at: null,
      cancelled_by_type: null,
      cancelled_by: null,
      ...overrides,
    });
    const insert = (overrides: Record<string, unknown> = {}) => owner.insertInto('appointments').values(row(overrides)).returning('id').executeTakeFirstOrThrow();
    beforeAll(async () => {
      providerId = (await newProvider('Dr DB')).id;
      patientId = (await newPatient()).id;
    });

    it('refuses overlapping appointments for one provider, but allows back-to-back ones and other providers', async () => {
      const base = new Date(at(31, '09:00')).getTime();
      const t = (min: number) => new Date(base + min * 60_000);
      await insert({ starts_at: t(0), ends_at: t(30) });
      for (const [from, to] of [[0, 30], [10, 20], [-10, 10], [29, 59], [-30, 60]] as const) {
        await expect(insert({ patient_id: (await newPatient()).id, starts_at: t(from), ends_at: t(to) })).rejects.toThrow(/appointments_provider_no_overlap/);
      }
      await insert({ patient_id: (await newPatient()).id, starts_at: t(30), ends_at: t(60) });
      await insert({ patient_id: (await newPatient()).id, starts_at: t(-30), ends_at: t(0) });
      await insert({ patient_id: (await newPatient()).id, provider_id: (await newProvider('Dr Other')).id, starts_at: t(0), ends_at: t(30) });
    });

    it('a cancelled appointment does not block its time, but a completed or no-show one still does', async () => {
      const base = new Date(at(32, '09:00')).getTime();
      const t = (min: number) => new Date(base + min * 60_000);
      const stamp = { cancelled_at: new Date(), cancelled_by_type: 'ai' as const };
      await insert({ status: 'cancelled', starts_at: t(0), ends_at: t(30), ...stamp });
      await insert({ patient_id: (await newPatient()).id, starts_at: t(0), ends_at: t(30) });
      for (const status of ['completed', 'no_show']) {
        const day = new Date(base + (status === 'completed' ? 2 : 3) * DAY);
        await insert({ status, starts_at: day, ends_at: new Date(day.getTime() + 30 * 60_000) });
        await expect(insert({ patient_id: (await newPatient()).id, starts_at: day, ends_at: new Date(day.getTime() + 30 * 60_000) })).rejects.toThrow(/appointments_provider_no_overlap/);
      }
    });

    it('refuses one patient in two places at once, across providers', async () => {
      const base = new Date(at(33, '09:00')).getTime();
      const patient = (await newPatient()).id;
      await insert({ patient_id: patient, starts_at: new Date(base), ends_at: new Date(base + 30 * 60_000) });
      await expect(
        insert({ patient_id: patient, provider_id: (await newProvider('Dr Elsewhere2')).id, starts_at: new Date(base + 10 * 60_000), ends_at: new Date(base + 40 * 60_000) }),
      ).rejects.toThrow(/appointments_patient_no_overlap/);
    });

    it.each([
      ['an end that is not after the start', { starts_at: new Date(at(34, '09:00')), ends_at: new Date(at(34, '09:00')) }],
      ['a status that does not exist', { status: 'maybe' }],
      ['"cancelled" without a cancellation time', { status: 'cancelled' }],
      ['a cancellation time on a booked appointment', { cancelled_at: new Date(), cancelled_by_type: 'ai' }],
      ['a cancellation that names nobody who cancelled it', { status: 'cancelled', cancelled_at: new Date() }],
      ['a cancellation by staff that names no person', { status: 'cancelled', cancelled_at: new Date(), cancelled_by_type: 'user', cancelled_by: null }],
      ['a cancelling person without a cancellation', { cancelled_by_type: 'ai' }],
      ['an AI booking that names a person', { booked_by_type: 'ai', booked_by: SOME_UUID }],
      ['a staff booking that names no one', { booked_by_type: 'user', booked_by: null }],
      ['a key that is too short', { idempotency_key: 'short' }],
      ['a cancel reason over 200 characters', { cancel_reason: 'x'.repeat(201) }],
    ])('refuses %s', async (_name, overrides) => {
      await expect(insert(overrides)).rejects.toThrow(/check constraint/);
    });

    it('keys are unique within a practice', async () => {
      const key = newKey();
      await insert({ idempotency_key: key, starts_at: new Date(at(40, '09:00')), ends_at: new Date(at(40, '09:30')) });
      await expect(insert({ idempotency_key: key, patient_id: (await newPatient()).id, starts_at: new Date(at(40, '10:00')), ends_at: new Date(at(40, '10:30')) })).rejects.toThrow(/appointments_idempotency_key_unique/);
    });

    it('cannot point at another practice’s patient, provider or visit type, even with direct database access', async () => {
      const betaPatient = (await owner.selectFrom('patients').select('id').where('practice_id', '=', beta.practiceId).limit(1).executeTakeFirstOrThrow()).id;
      const betaProvider = (await owner.selectFrom('providers').select('id').where('practice_id', '=', beta.practiceId).limit(1).executeTakeFirstOrThrow()).id;
      const betaType = (await owner.selectFrom('appointment_types').select('id').where('practice_id', '=', beta.practiceId).limit(1).executeTakeFirstOrThrow()).id;
      const at36 = { starts_at: new Date(at(36, '09:00')), ends_at: new Date(at(36, '09:30')) };
      await expect(insert({ ...at36, patient_id: betaPatient })).rejects.toThrow(/foreign key/);
      await expect(insert({ ...at36, provider_id: betaProvider })).rejects.toThrow(/foreign key/);
      await expect(insert({ ...at36, appointment_type_id: betaType })).rejects.toThrow(/foreign key/);
      const mine = (await insert({ ...at36 })).id;
      await expect(insert({ starts_at: new Date(at(36, '10:00')), ends_at: new Date(at(36, '10:30')), practice_id: beta.practiceId, patient_id: betaPatient, provider_id: betaProvider, appointment_type_id: betaType, rescheduled_from_id: mine })).rejects.toThrow(/foreign key/);
    });

    it('lets the API change only an appointment’s status and cancellation details, and delete nothing', async () => {
      const id = (await insert({ starts_at: new Date(at(37, '09:00')), ends_at: new Date(at(37, '09:30')) })).id;
      const inAlpha = <T>(work: Parameters<typeof withPracticeContext<T>>[2]) => withPracticeContext(appDb, { practiceId: alpha.practiceId }, work);
      await inAlpha((trx) => trx.updateTable('appointments').set({ status: 'cancelled', cancelled_at: new Date(), cancelled_by_type: 'ai', cancel_reason: 'ok' }).where('id', '=', id).execute());
      for (const change of [
        { starts_at: new Date(at(38, '09:00')) },
        { ends_at: new Date(at(38, '09:30')) },
        { patient_id: SOME_UUID },
        { provider_id: SOME_UUID },
        { practice_id: beta.practiceId },
        { booked_by_type: 'user' as const },
        { idempotency_key: 'a-different-key' },
        { rescheduled_from_id: id },
      ]) {
        await expect(inAlpha((trx) => trx.updateTable('appointments').set(change as never).where('id', '=', id).execute()), JSON.stringify(Object.keys(change))).rejects.toThrow(/permission denied/);
      }
      await expect(inAlpha((trx) => trx.deleteFrom('appointments').execute())).rejects.toThrow(/permission denied/);
      await expect(inAlpha((trx) => trx.deleteFrom('patients').execute())).rejects.toThrow(/permission denied/);
      await expect(inAlpha((trx) => trx.updateTable('patients').set({ first_name: 'Changed' }).execute())).rejects.toThrow(/permission denied/);
    });

    it('isolates both tables by practice (row-level security)', async () => {
      for (const table of ['patients', 'appointments'] as const) {
        const seen = await withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) => trx.selectFrom(table).select('practice_id').execute());
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((r) => r.practice_id === alpha.practiceId)).toBe(true);
        expect(await appDb.selectFrom(table).selectAll().execute()).toEqual([]); // no practice, no rows
      }
    });

    it('refuses patient details that break the rules', async () => {
      const patient = (overrides: Record<string, unknown>) =>
        owner.insertInto('patients').values({ practice_id: alpha.practiceId, first_name: 'Db', last_name: 'Check', date_of_birth: '1990-01-01', phone: '+14155550000', created_by_type: 'ai', created_by: null, ...overrides }).execute();
      await expect(patient({ first_name: '  ' })).rejects.toThrow(/check constraint/);
      await expect(patient({ last_name: '' })).rejects.toThrow(/check constraint/);
      await expect(patient({ date_of_birth: '1899-12-31' })).rejects.toThrow(/check constraint/);
      await expect(patient({ phone: '0300123' })).rejects.toThrow(/check constraint/);
      await expect(patient({ created_by_type: 'user', created_by: null })).rejects.toThrow(/check constraint/);
      await patient({});
      await expect(patient({ first_name: 'DB', last_name: 'CHECK' })).rejects.toThrow(/patients_identity_unique/); // same person, different capitals
    });
  });
});
