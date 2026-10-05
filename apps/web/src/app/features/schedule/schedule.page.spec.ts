import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { emptyBusinessHours, type Appointment, type AppointmentType, type AvailabilityResponse, type Patient, type Provider, type SchedulingSettings } from '@frontdesk/shared';
import { httpProviders, makeSession, render, signIn } from '../../testing/helpers';
import { SchedulePage } from './schedule.page';

// "Now" is Monday 5 October 2026, 11:00 in New York (the test practice's time zone).
const NOW = new Date('2026-10-05T15:00:00Z');
// Midnight in New York on that Monday and on the Tuesday (summer time: 4 hours behind UTC).
const MON = '2026-10-05T04:00:00.000Z';
const TUE = '2026-10-06T04:00:00.000Z';

const settings = (extra: Partial<SchedulingSettings> = {}): SchedulingSettings => ({
  slotMinutes: 30,
  minNoticeHours: 0,
  maxAdvanceDays: 60,
  cancelMinHours: 24,
  aiBookingEnabled: true,
  timeFormat: '12h',
  identityFailureCapPerHour: 30,
  updatedAt: null,
  ...extra,
});
const provider = (id: string, name: string): Provider => ({
  id,
  name,
  title: '',
  hours: emptyBusinessHours(),
  active: true,
  appointmentTypeIds: ['t1'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});
const followUp: AppointmentType = { id: 't1', name: 'Follow-up', durationMinutes: 30, active: true, providerIds: ['p1', 'p2'] };
const appointment = (id: string, startsAt: string, extra: Partial<Appointment> = {}): Appointment => ({
  id,
  patient: { id: 'pa1', firstName: 'Sara', lastName: 'Ali' },
  providerId: 'p1',
  providerName: 'Dr Khan',
  appointmentTypeId: 't1',
  appointmentTypeName: 'Follow-up',
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
  status: 'booked',
  bookedBy: 'user',
  cancelledAt: null,
  cancelReason: '',
  rescheduledFromId: null,
  ...extra,
});
const sara: Patient = { id: 'pa1', firstName: 'Sara', lastName: 'Ali', dateOfBirth: '1991-02-03', phone: '+14155550111', createdAt: '2026-10-01T00:00:00.000Z' };
const open = (...starts: string[]): AvailabilityResponse => ({
  timezone: 'America/New_York',
  slots: starts.map((startsAt) => ({ providerId: 'p1', providerName: 'Dr Khan', appointmentTypeId: 't1', startsAt, endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString() })),
});

describe('SchedulePage', () => {
  let fixture: ComponentFixture<SchedulePage>;
  let http: HttpTestingController;

  async function setup(options: { settings?: SchedulingSettings; appointments?: Appointment[] } = {}) {
    TestBed.configureTestingModule({ imports: [SchedulePage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: 'staff' }));
    fixture = TestBed.createComponent(SchedulePage);
    await render(fixture);
    http.expectOne('/api/scheduling/settings').flush(options.settings ?? settings());
    http.expectOne('/api/providers').flush([provider('p1', 'Dr Khan'), provider('p2', 'Dr Lee')]);
    http.expectOne('/api/appointment-types').flush([followUp]);
    await render(fixture);
    calendar().flush(options.appointments ?? []);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent!.replace(/\s+/g, ' ');
  const field = <T extends HTMLElement>(id: string) => root().querySelector<T>(`#${id}`)!;
  const button = (label: string) => [...root().querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim().startsWith(label));
  const click = async (element: HTMLElement | undefined) => {
    element!.click();
    await render(fixture);
  };
  const type = async (id: string, value: string) => {
    const element = field<HTMLInputElement>(id);
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await render(fixture);
  };
  const choose = async (id: string, value: string) => {
    const element = field<HTMLSelectElement>(id);
    element.value = value;
    element.dispatchEvent(new Event('change'));
    await render(fixture);
  };
  const calendar = () => http.expectOne((r) => r.url === '/api/appointments' && r.method === 'GET');
  const alerts = () => [...root().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());

  /** Opens the booking panel and lists open times for a follow-up. */
  async function findTimes(...starts: string[]) {
    await click(button('Book an appointment'));
    await choose('book-type', 't1');
    await click(button('Find open times'));
    const request = http.expectOne((r) => r.url === '/api/availability');
    expect(request.request.params.get('appointmentTypeId')).toBe('t1');
    request.flush(open(...starts));
    await render(fixture);
  }
  const pickSlot = async (index = 0) => {
    const radio = root().querySelectorAll<HTMLInputElement>('input[name="slot"]')[index]!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    await render(fixture);
  };
  async function pickSara() {
    await type('patient-search', 'ali');
    await click(button('Search'));
    const search = http.expectOne((r) => r.url === '/api/patients');
    expect(search.request.params.get('q')).toBe('ali');
    search.flush([sara]);
    await render(fixture);
    await click(button('Sara Ali'));
  }
  const bookRequest = () => http.expectOne((r) => r.url === '/api/appointments' && r.method === 'POST');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  describe('the calendar', () => {
    it('shows today on the practice’s clock, asking for exactly that day', async () => {
      TestBed.configureTestingModule({ imports: [SchedulePage], providers: httpProviders() });
      http = TestBed.inject(HttpTestingController);
      await signIn(makeSession({ role: 'staff' }));
      fixture = TestBed.createComponent(SchedulePage);
      await render(fixture);
      http.expectOne('/api/scheduling/settings').flush(settings());
      http.expectOne('/api/providers').flush([provider('p1', 'Dr Khan')]);
      http.expectOne('/api/appointment-types').flush([followUp]);
      await render(fixture);
      const request = calendar();
      expect(request.request.params.get('from')).toBe(MON);
      expect(request.request.params.get('to')).toBe(TUE);
      expect(request.request.params.get('status')).toBe('booked');
      request.flush([appointment('a2', '2026-10-05T18:30:00.000Z'), appointment('a1', '2026-10-05T13:00:00.000Z', { bookedBy: 'ai', patient: { id: 'pa2', firstName: 'Omar', lastName: 'Raza' } })]);
      await render(fixture);

      expect(root().querySelector('h2#calendar-title')?.textContent).toBe('Monday 5 October');
      const rows = [...root().querySelectorAll('.appointment')].map((row) => row.textContent!.replace(/\s+/g, ' ').trim());
      expect(rows[0]).toContain('9:00 AM–9:30 AM');
      expect(rows[0]).toContain('Omar Raza');
      expect(rows[0]).toContain('Booked by AI');
      expect(rows[1]).toContain('2:30 PM–3:00 PM');
      expect(rows[1]).toContain('Sara Ali · Follow-up · Dr Khan');
      expect(rows[1]).not.toContain('Booked by AI');
    });

    it('uses the 24-hour clock when the practice chose it', async () => {
      await setup({ settings: settings({ timeFormat: '24h' }), appointments: [appointment('a1', '2026-10-05T18:30:00.000Z')] });
      expect(text()).toContain('14:30–15:00');
    });

    it('never shows a patient’s date of birth or phone on the calendar', async () => {
      await setup({ appointments: [appointment('a1', '2026-10-05T13:00:00.000Z')] });
      expect(text()).not.toContain('1991');
      expect(text()).not.toContain('+1415');
    });

    it('moves a day at a time, and a week at a time in the week view (Monday to Sunday)', async () => {
      await setup();
      await click(button('Next'));
      let request = calendar();
      expect(request.request.params.get('from')).toBe(TUE);
      request.flush([]);
      await render(fixture);
      expect(root().querySelector('h2#calendar-title')?.textContent).toBe('Tuesday 6 October');

      await click(button('Week'));
      request = calendar();
      expect(request.request.params.get('from')).toBe(MON);
      expect(request.request.params.get('to')).toBe('2026-10-12T04:00:00.000Z');
      request.flush([appointment('a1', '2026-10-07T13:00:00.000Z')]);
      await render(fixture);
      expect(root().querySelector('h2#calendar-title')?.textContent).toBe('Monday 5 October to Sunday 11 October');
      expect([...root().querySelectorAll('h3.day-heading')].map((h) => h.textContent)).toHaveLength(7);
      expect(text()).toContain('Wednesday 7 October');

      await click(button('Previous'));
      request = calendar();
      expect(request.request.params.get('from')).toBe('2026-09-28T04:00:00.000Z');
      request.flush([]);
      await render(fixture);

      await click(button('Today'));
      calendar().flush([]);
      await render(fixture);
      expect(root().querySelector('h2#calendar-title')?.textContent).toBe('Monday 5 October to Sunday 11 October');
    });

    it('filters by provider and shows cancelled appointments only when asked', async () => {
      await setup();
      await choose('provider-filter', 'p2');
      let request = calendar();
      expect(request.request.params.get('providerId')).toBe('p2');
      request.flush([]);
      await render(fixture);
      const box = root().querySelector<HTMLInputElement>('label.check input')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await render(fixture);
      request = calendar();
      expect(request.request.params.get('status')).toBe('all');
      request.flush([appointment('a1', '2026-10-05T13:00:00.000Z', { status: 'cancelled', cancelledAt: '2026-10-04T00:00:00.000Z' })]);
      await render(fixture);
      expect(root().querySelector('.appointment.cancelled')).not.toBeNull();
      expect(text()).toContain('Cancelled');
      expect(button('Move')).toBeUndefined(); // a cancelled appointment cannot be moved or cancelled again
    });
  });

  describe('booking', () => {
    it('books an open time for a patient found by search, with an idempotency key, and shows it', async () => {
      await setup();
      await findTimes('2026-10-06T13:00:00.000Z', '2026-10-06T13:30:00.000Z');
      expect(text()).toContain('Tue 6 Oct, 9:00 AM · Dr Khan');
      await pickSlot(1);
      await pickSara();
      expect(text()).toContain('born 1991-02-03'); // in the booking form, to tell people apart
      await click(button('Book Tue 6 Oct, 9:30 AM'));

      const request = bookRequest();
      expect(request.request.body).toEqual({ patientId: 'pa1', providerId: 'p1', appointmentTypeId: 't1', startsAt: '2026-10-06T13:30:00.000Z' });
      expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
      request.flush(appointment('a9', '2026-10-06T13:30:00.000Z'));
      await render(fixture);
      const reload = calendar();
      expect(reload.request.params.get('from')).toBe(TUE); // the calendar jumps to the booked day
      reload.flush([appointment('a9', '2026-10-06T13:30:00.000Z')]);
      await render(fixture);
      expect(text()).toContain('Booked: Sara Ali, Follow-up with Dr Khan, Tue 6 Oct, 9:30 AM.');
      expect(root().querySelector('#book-type')).toBeNull(); // the booking form closed
    });

    it('can narrow the search to one provider and start from a later date', async () => {
      await setup();
      await click(button('Book an appointment'));
      await choose('book-type', 't1');
      await choose('book-provider', 'p2');
      await type('book-from', '2026-10-20');
      await click(button('Find open times'));
      const request = http.expectOne((r) => r.url === '/api/availability');
      expect(request.request.params.get('providerId')).toBe('p2');
      expect(request.request.params.get('from')).toBe('2026-10-20T04:00:00.000Z');
      request.flush(open());
      await render(fixture);
      expect(text()).toContain('No open times from that date.');
    });

    it('adds a new patient, then books for them', async () => {
      await setup();
      await findTimes('2026-10-06T13:00:00.000Z');
      await pickSlot();
      await click(button('New patient'));
      expect(button('Book Tue')!.disabled).toBe(true);
      await type('new-first', 'Bilal');
      await type('new-last', 'Ahmed');
      await type('new-dob', '1985-07-09');
      await type('new-phone', '+923001234567');
      expect(button('Book Tue')!.disabled).toBe(false);
      await click(button('Book Tue'));
      const add = http.expectOne((r) => r.url === '/api/patients' && r.method === 'POST');
      expect(add.request.body).toEqual({ firstName: 'Bilal', lastName: 'Ahmed', dateOfBirth: '1985-07-09', phone: '+923001234567' });
      add.flush({ ...sara, id: 'pa7', firstName: 'Bilal', lastName: 'Ahmed' });
      await render(fixture);
      const request = bookRequest();
      expect(request.request.body.patientId).toBe('pa7');
      request.flush(appointment('a9', '2026-10-06T13:00:00.000Z'));
      await render(fixture);
      calendar().flush([]);
      await render(fixture);
    });

    it.each([
      ['a phone without the country code', { phone: '03001234567' }, 'country code'],
      ['a date of birth in the future', { dateOfBirth: '2030-01-01' }, 'real date of birth'],
      ['no last name', { lastName: '' }, 'first and last name'],
    ])('will not add a patient with %s', async (_name, change, message) => {
      await setup();
      await findTimes('2026-10-06T13:00:00.000Z');
      await pickSlot();
      await click(button('New patient'));
      const values = { firstName: 'Bilal', lastName: 'Ahmed', dateOfBirth: '1985-07-09', phone: '+923001234567', ...change };
      await type('new-first', values.firstName);
      await type('new-last', values.lastName);
      await type('new-dob', values.dateOfBirth);
      await type('new-phone', values.phone);
      expect(button('Book Tue')!.disabled).toBe(true);
      expect(text()).toContain(message);
    });

    it('a retry after a lost answer uses the same key (so it books once), and does not add the patient twice', async () => {
      await setup();
      await findTimes('2026-10-06T13:00:00.000Z');
      await pickSlot();
      await click(button('New patient'));
      await type('new-first', 'Bilal');
      await type('new-last', 'Ahmed');
      await type('new-dob', '1985-07-09');
      await type('new-phone', '+923001234567');
      await click(button('Book Tue'));
      http.expectOne((r) => r.url === '/api/patients' && r.method === 'POST').flush({ ...sara, id: 'pa7' });
      await render(fixture);
      const first = bookRequest();
      const key = first.request.headers.get('Idempotency-Key');
      first.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' }); // the answer was lost
      await render(fixture);
      expect(alerts().join(' ')).toContain('Cannot reach the server');

      await click(button('Book Tue'));
      const second = bookRequest(); // and no second POST /api/patients
      expect(second.request.headers.get('Idempotency-Key')).toBe(key);
      expect(second.request.body.patientId).toBe('pa7');
      second.flush(appointment('a9', '2026-10-06T13:00:00.000Z'));
      await render(fixture);
      calendar().flush([]);
      await render(fixture);
    });

    it('a different time is a different booking, with a new key', async () => {
      await setup();
      await findTimes('2026-10-06T13:00:00.000Z', '2026-10-06T13:30:00.000Z');
      await pickSlot(0);
      await pickSara();
      await click(button('Book Tue'));
      const first = bookRequest();
      const key = first.request.headers.get('Idempotency-Key');
      first.flush({ message: 'Something odd' }, { status: 500, statusText: 'x' });
      await render(fixture);
      await pickSlot(1);
      await click(button('Book Tue'));
      const second = bookRequest();
      expect(second.request.headers.get('Idempotency-Key')).not.toBe(key);
      second.flush(appointment('a9', '2026-10-06T13:30:00.000Z'));
      await render(fixture);
      calendar().flush([]);
      await render(fixture);
    });

    it('when the time was just taken, says so and shows the times open now', async () => {
      await setup();
      await findTimes('2026-10-06T13:00:00.000Z', '2026-10-06T13:30:00.000Z');
      await pickSlot(0);
      await pickSara();
      await click(button('Book Tue'));
      bookRequest().flush({ message: 'That time was just taken' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      http.expectOne((r) => r.url === '/api/availability').flush(open('2026-10-06T13:30:00.000Z'));
      await render(fixture);
      expect(alerts().join(' ')).toContain('That time was just taken. Here are the times open now.');
      expect(root().querySelectorAll('input[name="slot"]')).toHaveLength(1);
      expect(button('Book Tue')).toBeUndefined(); // the taken time is no longer chosen
    });
  });

  describe('cancelling and moving', () => {
    const booked = appointment('a1', '2026-10-05T18:30:00.000Z');

    it('cancels with a reason after asking, and reloads the day', async () => {
      await setup({ appointments: [booked] });
      await click(button('Cancel'));
      await type('cancel-reason', 'Patient called');
      await click(button('Cancel the appointment'));
      const request = http.expectOne((r) => r.url === '/api/appointments/a1/cancel');
      expect(request.request.body).toEqual({ reason: 'Patient called' });
      request.flush({ ...booked, status: 'cancelled' });
      await render(fixture);
      calendar().flush([]);
      await render(fixture);
      expect(text()).toContain('Cancelled: Sara Ali, Mon 5 Oct, 2:30 PM.');
    });

    it('“Keep it” changes nothing', async () => {
      await setup({ appointments: [booked] });
      await click(button('Cancel'));
      await click(button('Keep it'));
      expect(root().querySelector('#cancel-reason')).toBeNull();
    });

    it('moves to an open time for the same visit, with an idempotency key', async () => {
      await setup({ appointments: [booked] });
      await click(button('Move'));
      const search = http.expectOne((r) => r.url === '/api/availability');
      expect(search.request.params.get('appointmentTypeId')).toBe('t1');
      search.flush(open('2026-10-07T13:00:00.000Z'));
      await render(fixture);
      await click(button('Wed 7 Oct, 9:00 AM'));
      const request = http.expectOne((r) => r.url === '/api/appointments/a1/reschedule');
      expect(request.request.body).toEqual({ startsAt: '2026-10-07T13:00:00.000Z', providerId: 'p1' });
      expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
      request.flush(appointment('a2', '2026-10-07T13:00:00.000Z', { rescheduledFromId: 'a1' }));
      await render(fixture);
      calendar().flush([]);
      await render(fixture);
      expect(text()).toContain('Moved: Sara Ali to Wed 7 Oct, 9:00 AM with Dr Khan.');
    });

    it('shows the reason when a move is refused, and fresh open times when the time was taken', async () => {
      await setup({ appointments: [booked] });
      await click(button('Move'));
      http.expectOne((r) => r.url === '/api/availability').flush(open('2026-10-07T13:00:00.000Z'));
      await render(fixture);
      await click(button('Wed 7 Oct, 9:00 AM'));
      http.expectOne((r) => r.url === '/api/appointments/a1/reschedule').flush({ message: 'That time is not available' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      http.expectOne((r) => r.url === '/api/availability').flush(open('2026-10-07T14:00:00.000Z'));
      await render(fixture);
      expect(alerts().join(' ')).toContain('That time is not available');
      expect(button('Wed 7 Oct, 10:00 AM')).toBeDefined();
    });
  });

  it('says why when the page cannot be loaded', async () => {
    TestBed.configureTestingModule({ imports: [SchedulePage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: 'staff' }));
    fixture = TestBed.createComponent(SchedulePage);
    await render(fixture);
    http.expectOne('/api/scheduling/settings').flush({ message: 'x' }, { status: 500, statusText: 'x' });
    http.expectOne('/api/providers').flush([]);
    http.expectOne('/api/appointment-types').flush([]);
    await render(fixture);
    expect(alerts()[0]).toBe('Something went wrong. Please try again.');
    expect(button('Book an appointment')).toBeUndefined();
  });

});
