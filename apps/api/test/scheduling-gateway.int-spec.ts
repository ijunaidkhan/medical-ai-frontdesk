import { WEEKDAYS, type AppointmentType } from '@frontdesk/shared';
import { DB, type Db } from '../src/database/database.module.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { SchedulingGateways } from '../src/scheduling/gateway/scheduling-gateways.js';
import { startTestApp } from './support/app.js';
import { as, signIn } from './support/auth-helpers.js';
import { addMember, connect, seedPractice } from './support/fixtures.js';
import { describeGatewayContract, type GatewayWorld } from './support/gateway-contract.js';
import { createIsolatedDatabase } from './support/test-database.js';

const ALL_DAY = Object.fromEntries(WEEKDAYS.map((day) => [day, [{ open: '00:00', close: '24:00' }]]));
const PATIENT = { firstName: 'Sara', lastName: 'Contract', dateOfBirth: '1991-02-03', phone: '+14155550101' };

/** Our own calendar: the practice set up through the staff API, the gateway taken from the running app. */
async function nativeWorld(): Promise<GatewayWorld> {
  const database = await createIsolatedDatabase();
  process.env['DATABASE_URL'] = database.appUrl;
  const owner = connect(database.ownerUrl);
  const app = await startTestApp();

  const prepare = async (slug: string) => {
    const { practiceId } = await seedPractice(owner, slug);
    await addMember(owner, practiceId, `admin@${slug}.test`, 'admin');
    const token = (await signIn(app, { email: `admin@${slug}.test` })).session.accessToken;
    const visit = (await as(app, token).post('/api/appointment-types', { name: 'Visit', durationMinutes: 30 }).expect(201)).body as AppointmentType;
    await as(app, token).post('/api/providers', { name: `Dr ${slug}`, hours: ALL_DAY, appointmentTypeIds: [visit.id] }).expect(201);
    await as(app, token).patch('/api/scheduling/settings', { slotMinutes: 30, minNoticeHours: 0, maxAdvanceDays: 365, cancelMinHours: 0 }).expect(200);
    return { practiceId, token };
  };
  const home = await prepare('home');
  const other = await prepare('other');
  await as(app, home.token).post('/api/patients', PATIENT).expect(201);

  const db = app.get<Db>(DB);
  const gateways = app.get(SchedulingGateways);
  return {
    gateway: await withPracticeContext(db, { practiceId: home.practiceId }, (trx) => gateways.forPractice({ trx, practiceId: home.practiceId, meta: { ip: null, userAgent: null, requestId: null } })),
    run: (practice, work) => {
      const { practiceId } = practice === 'home' ? home : other;
      return withPracticeContext(db, { practiceId }, (trx) => work({ trx, practiceId, meta: { ip: null, userAgent: null, requestId: `contract-${practice}` } }));
    },
    visitTypeName: 'Visit',
    patient: PATIENT,
    setCancellationWindowHours: async (hours) => {
      await as(app, home.token).patch('/api/scheduling/settings', { cancelMinHours: hours }).expect(200);
    },
    addPastAppointment: async () => {
      const patient = await owner.selectFrom('patients').select('id').where('practice_id', '=', home.practiceId).where('last_name', '=', PATIENT.lastName).executeTakeFirstOrThrow();
      const provider = await owner.selectFrom('providers').select('id').where('practice_id', '=', home.practiceId).executeTakeFirstOrThrow();
      const type = await owner.selectFrom('appointment_types').select('id').where('practice_id', '=', home.practiceId).executeTakeFirstOrThrow();
      const startsAt = new Date(Math.floor((Date.now() - 86_400_000) / 1_800_000) * 1_800_000);
      const row = await owner
        .insertInto('appointments')
        .values({
          practice_id: home.practiceId,
          patient_id: patient.id,
          provider_id: provider.id,
          appointment_type_id: type.id,
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + 30 * 60_000),
          booked_by_type: 'ai',
          booked_by: null,
          rescheduled_from_id: null,
          idempotency_key: `contract-past-${startsAt.getTime()}`,
          conversation_id: null,
          cancelled_at: null,
          cancelled_by_type: null,
          cancelled_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    close: async () => {
      await app.close();
      await owner.destroy();
      await database.drop();
    },
  };
}

describeGatewayContract('our own calendar (NativeAdapter)', nativeWorld);
