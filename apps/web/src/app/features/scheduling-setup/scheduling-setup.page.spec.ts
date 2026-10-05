import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { emptyBusinessHours, type AppointmentType, type Provider, type ProviderTimeOff, type Role, type SchedulingSettings } from '@frontdesk/shared';
import { AuthService } from '../../core/auth/auth.service';
import { httpProviders, makeSession, PRACTICE_A, PRACTICE_B, render, signIn } from '../../testing/helpers';
import { SchedulingSetupPage } from './scheduling-setup.page';

const settings = (extra: Partial<SchedulingSettings> = {}): SchedulingSettings => ({
  slotMinutes: 15,
  minNoticeHours: 2,
  maxAdvanceDays: 60,
  cancelMinHours: 24,
  aiBookingEnabled: false,
  timeFormat: '12h',
  identityFailureCapPerHour: 30,
  updatedAt: null,
  ...extra,
});

const MON_9_TO_12 = { ...emptyBusinessHours(), mon: [{ open: '09:00', close: '12:00' }] };

const provider = (id: string, name: string, extra: Partial<Provider> = {}): Provider => ({
  id,
  name,
  title: '',
  hours: MON_9_TO_12,
  active: true,
  appointmentTypeIds: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

const visitType = (id: string, name: string, extra: Partial<AppointmentType> = {}): AppointmentType => ({ id, name, durationMinutes: 30, active: true, providerIds: [], ...extra });

describe('SchedulingSetupPage', () => {
  let fixture: ComponentFixture<SchedulingSetupPage>;
  let http: HttpTestingController;

  const khan = provider('p1', 'Dr Khan', { title: 'Family doctor', appointmentTypeIds: ['t1'] });
  const lee = provider('p2', 'Dr Lee', { active: false });
  const followUp = visitType('t1', 'Follow-up', { providerIds: ['p1'] });

  async function setup(options: { role?: Role; settings?: SchedulingSettings; providers?: Provider[]; types?: AppointmentType[] } = {}) {
    TestBed.configureTestingModule({ imports: [SchedulingSetupPage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: options.role ?? 'admin' }));
    fixture = TestBed.createComponent(SchedulingSetupPage);
    await render(fixture);
    http.expectOne('/api/scheduling/settings').flush(options.settings ?? settings());
    http.expectOne('/api/providers').flush(options.providers ?? [khan, lee]);
    http.expectOne('/api/appointment-types').flush(options.types ?? [followUp]);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const field = <T extends HTMLElement>(id: string) => root().querySelector<T>(`#${id}`)!;
  const buttons = (text: string) => [...root().querySelectorAll('button')].filter((b) => b.textContent?.replace(/\s+/g, ' ').trim().startsWith(text));
  const button = (text: string) => buttons(text)[0];
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
  const click = async (element: HTMLElement | undefined) => {
    element!.click();
    await render(fixture);
  };
  const tick = async (label: string) => {
    const box = [...root().querySelectorAll<HTMLLabelElement>('label.choice')].find((l) => l.textContent?.includes(label))!.querySelector('input')!;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    await render(fixture);
  };
  const alerts = () => [...root().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());
  const reloadLists = (providers: Provider[], types: AppointmentType[]) => {
    http.expectOne('/api/providers').flush(providers);
    http.expectOne('/api/appointment-types').flush(types);
  };

  afterEach(() => http.verify());

  describe('showing the setup', () => {
    it('shows the rules, the providers with what they offer, and the kinds of visit', async () => {
      await setup();
      expect(field<HTMLSelectElement>('slot-minutes').value).toBe('15');
      expect(field<HTMLInputElement>('min-notice').value).toBe('2');
      expect(field<HTMLInputElement>('cancel-window').value).toBe('24');
      expect(field<HTMLSelectElement>('time-format').value).toBe('12h');
      expect(field<HTMLInputElement>('identity-cap').value).toBe('30');
      const text = root().textContent!;
      expect(text).toContain('Dr Khan');
      expect(text).toContain('Family doctor');
      expect(text).toContain('Follow-up');
      expect(text).toContain('Switched off'); // Dr Lee
      expect(text).toContain('America/New_York');
      expect(text).toContain('may not book');
    });

    it('lets staff look but not change anything', async () => {
      await setup({ role: 'staff' });
      expect(root().textContent).toContain('only an owner or administrator can change it');
      expect(field<HTMLInputElement>('min-notice').disabled).toBe(true);
      expect(button('Save rules')).toBeUndefined();
      expect(button('Let the AI book')).toBeUndefined();
      expect(button('Add a provider')).toBeUndefined();
      expect(button('Change')).toBeUndefined();
      expect(button('Switch off')).toBeUndefined();
      expect(button('Days off')).toBeDefined(); // looking at days off is allowed
    });

    it('shows an error when the setup cannot be loaded', async () => {
      TestBed.configureTestingModule({ imports: [SchedulingSetupPage], providers: httpProviders() });
      http = TestBed.inject(HttpTestingController);
      await signIn(makeSession({ role: 'admin' }));
      fixture = TestBed.createComponent(SchedulingSetupPage);
      await render(fixture);
      http.expectOne('/api/scheduling/settings').flush({ message: 'nope' }, { status: 500, statusText: 'x' });
      http.expectOne('/api/providers').flush([]);
      http.expectOne('/api/appointment-types').flush([]);
      await render(fixture);
      expect(alerts()[0]).toBe('Something went wrong. Please try again.');
      expect(root().querySelector('form')).toBeNull();
    });

    it('loads the other practice’s setup after switching practice, and ignores a late answer for the old one', async () => {
      TestBed.configureTestingModule({ imports: [SchedulingSetupPage], providers: httpProviders() });
      http = TestBed.inject(HttpTestingController);
      await signIn(makeSession({ role: 'admin', practices: [{ ...PRACTICE_A, role: 'admin' }, { ...PRACTICE_B, role: 'admin' }] }));
      fixture = TestBed.createComponent(SchedulingSetupPage);
      await render(fixture);
      const oldSettings = http.expectOne('/api/scheduling/settings');
      const oldProviders = http.expectOne('/api/providers');
      const oldTypes = http.expectOne('/api/appointment-types');

      const auth = TestBed.inject(AuthService);
      const switching = auth.switchPractice(PRACTICE_B.id);
      http.expectOne('/api/auth/switch-practice').flush(makeSession({ role: 'admin', current: { ...PRACTICE_B, role: 'admin' }, practices: [{ ...PRACTICE_A, role: 'admin' }, { ...PRACTICE_B, role: 'admin' }] }));
      await switching;
      await render(fixture);
      http.expectOne('/api/scheduling/settings').flush(settings({ slotMinutes: 60 }));
      http.expectOne('/api/providers').flush([provider('b1', 'Dr Beta')]);
      http.expectOne('/api/appointment-types').flush([]);
      oldSettings.flush(settings({ slotMinutes: 5 }));
      oldProviders.flush([khan]);
      oldTypes.flush([followUp]);
      await render(fixture);

      expect(field<HTMLSelectElement>('slot-minutes').value).toBe('60');
      expect(root().textContent).toContain('Dr Beta');
      expect(root().textContent).not.toContain('Dr Khan');
      expect(root().textContent).toContain('Asia/Karachi');
    });
  });

  describe('booking rules', () => {
    it('sends only what changed, and says when it is saved', async () => {
      await setup();
      expect(button('Save rules')!.disabled).toBe(true);
      await type('cancel-window', '48');
      await choose('time-format', '24h');
      await click(button('Save rules'));
      const request = http.expectOne((r) => r.url === '/api/scheduling/settings' && r.method === 'PATCH');
      expect(request.request.body).toEqual({ cancelMinHours: 48, timeFormat: '24h' });
      request.flush(settings({ cancelMinHours: 48, timeFormat: '24h' }));
      await render(fixture);
      expect(root().querySelector('[role="status"].alert')?.textContent).toContain('Saved.');
      expect(button('Save rules')!.disabled).toBe(true);
    });

    it('changes the slot length and the identity cap', async () => {
      await setup();
      await choose('slot-minutes', '30');
      await type('identity-cap', '50');
      await click(button('Save rules'));
      const request = http.expectOne((r) => r.method === 'PATCH');
      expect(request.request.body).toEqual({ slotMinutes: 30, identityFailureCapPerHour: 50 });
      request.flush(settings({ slotMinutes: 30, identityFailureCapPerHour: 50 }));
      await render(fixture);
    });

    it.each([
      ['min-notice', '-1', 'Minimum notice'],
      ['min-notice', '721', 'Minimum notice'],
      ['max-advance', '0', 'How far ahead'],
      ['cancel-window', 'two days', 'Cancellation window'],
      ['identity-cap', '4', 'Failed identity checks per hour'],
      ['identity-cap', '2.5', 'Failed identity checks per hour'],
    ])('will not save %s = %j, and says why', async (id, value, label) => {
      await setup();
      await type(id, value);
      expect(button('Save rules')!.disabled).toBe(true);
      expect(alerts().join(' ')).toContain(label);
    });

    it('shows the server’s reason when it refuses', async () => {
      await setup();
      await type('min-notice', '3');
      await click(button('Save rules'));
      http.expectOne((r) => r.method === 'PATCH').flush({ message: ['minNoticeHours must not be greater than 720'] }, { status: 400, statusText: 'Bad Request' });
      await render(fixture);
      expect(alerts().join(' ')).toContain('minNoticeHours must not be greater than 720');
    });
  });

  describe('letting the AI book', () => {
    it('switches it on separately from saving, and lists what is missing when refused', async () => {
      await setup();
      await click(button('Let the AI book'));
      const request = http.expectOne((r) => r.method === 'PATCH');
      expect(request.request.body).toEqual({ aiBookingEnabled: true });
      request.flush({ message: ['Give a provider working hours'] }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(alerts().join(' ')).toContain('Give a provider working hours');
      expect(root().textContent).toContain('may not book');
    });

    it('can be stopped, and is not offered while rule changes are unsaved', async () => {
      await setup({ settings: settings({ aiBookingEnabled: true }) });
      expect(root().textContent).toContain('may book');
      await type('min-notice', '4');
      expect(button('Stop the AI booking')!.disabled).toBe(true);
      await type('min-notice', '2');
      expect(button('Stop the AI booking')!.disabled).toBe(false);
      await click(button('Stop the AI booking'));
      const request = http.expectOne((r) => r.method === 'PATCH');
      expect(request.request.body).toEqual({ aiBookingEnabled: false });
      request.flush(settings({ aiBookingEnabled: false }));
      await render(fixture);
      expect(root().textContent).toContain('may not book');
    });
  });

  describe('providers', () => {
    it('adds a provider with hours and the visits they offer', async () => {
      await setup();
      await click(button('Add a provider'));
      expect(button('Add provider')!.disabled).toBe(true); // no name yet
      await type('provider-name', '  Dr Ali ');
      await click(button('Add a period on Tuesday'));
      await tick('Follow-up');
      await click(button('Add provider'));
      const request = http.expectOne((r) => r.url === '/api/providers' && r.method === 'POST');
      expect(request.request.body).toEqual({
        name: 'Dr Ali',
        title: '',
        hours: { ...emptyBusinessHours(), tue: [{ open: '09:00', close: '17:00' }] },
        appointmentTypeIds: ['t1'],
      });
      request.flush(provider('p3', 'Dr Ali'));
      await render(fixture);
      reloadLists([khan, lee, provider('p3', 'Dr Ali')], [followUp]);
      await render(fixture);
      expect(root().querySelector('#provider-name')).toBeNull(); // the editor closed
      expect(root().textContent).toContain('Dr Ali');
    });

    it('sends only what changed when a provider is edited', async () => {
      await setup();
      await click(button('Change'));
      expect(field<HTMLInputElement>('provider-name').value).toBe('Dr Khan');
      await type('provider-hours-mon-close-0', '13:00');
      await tick('Follow-up'); // stop offering it
      await click(button('Save changes'));
      const request = http.expectOne((r) => r.url === '/api/providers/p1' && r.method === 'PATCH');
      expect(request.request.body).toEqual({ hours: { ...emptyBusinessHours(), mon: [{ open: '09:00', close: '13:00' }] }, appointmentTypeIds: [] });
      request.flush(khan);
      await render(fixture);
      reloadLists([khan, lee], [followUp]);
      await render(fixture);
    });

    it('will not save hours that are not hours', async () => {
      await setup();
      await click(button('Change'));
      await type('provider-hours-mon-close-0', '08:00'); // closes before it opens
      expect(button('Save changes')!.disabled).toBe(true);
      expect(root().querySelector('.editor .field-error')?.textContent?.length).toBeGreaterThan(0);
    });

    it('switches a provider off and on (nothing is deleted)', async () => {
      await setup();
      await click(buttons('Switch off')[0]);
      const off = http.expectOne((r) => r.url === '/api/providers/p1' && r.method === 'PATCH');
      expect(off.request.body).toEqual({ active: false });
      off.flush({ ...khan, active: false });
      await render(fixture);
      reloadLists([{ ...khan, active: false }, lee], [followUp]);
      await render(fixture);
      expect(buttons('Switch on').length).toBe(2);
    });

    it('does not throw away unsaved changes when another editor is opened', async () => {
      await setup();
      await click(button('Change'));
      await type('provider-name', 'Dr Khan Senior');
      await click(button('Add a kind of visit'));
      expect(alerts().join(' ')).toContain('Save or discard the changes you are making first.');
      expect(field<HTMLInputElement>('provider-name').value).toBe('Dr Khan Senior');
      await click(button('Discard'));
      await click(button('Add a kind of visit'));
      expect(root().querySelector('#type-name')).not.toBeNull();
    });

    it('shows the server’s reason when it refuses', async () => {
      await setup();
      await click(button('Add a provider'));
      await type('provider-name', 'Dr X');
      await click(button('Add provider'));
      http.expectOne((r) => r.method === 'POST').flush({ message: 'One of the appointment types does not exist' }, { status: 400, statusText: 'Bad Request' });
      await render(fixture);
      expect(alerts().join(' ')).toContain('One of the appointment types does not exist');
      expect(field<HTMLInputElement>('provider-name').value).toBe('Dr X'); // nothing lost
    });
  });

  describe('kinds of visit', () => {
    it('adds one with its length and providers', async () => {
      await setup();
      await click(button('Add a kind of visit'));
      await type('type-name', 'New patient');
      await type('type-length', '40');
      await tick('Dr Khan');
      await click(button('Add kind of visit'));
      const request = http.expectOne((r) => r.url === '/api/appointment-types' && r.method === 'POST');
      expect(request.request.body).toEqual({ name: 'New patient', durationMinutes: 40, providerIds: ['p1'] });
      request.flush(visitType('t2', 'New patient'));
      await render(fixture);
      reloadLists([khan, lee], [followUp, visitType('t2', 'New patient', { durationMinutes: 40 })]);
      await render(fixture);
      expect(root().textContent).toContain('New patient');
    });

    it.each([['4'], ['481'], ['half an hour'], ['']])('will not save a length of %j minutes', async (length) => {
      await setup();
      await click(button('Add a kind of visit'));
      await type('type-name', 'Visit');
      await type('type-length', length);
      expect(button('Add kind of visit')!.disabled).toBe(true);
    });

    it('sends only what changed when one is edited, and switches it off', async () => {
      await setup();
      await click(buttons('Change').at(-1)); // the visit type's (after the providers')
      await type('type-length', '20');
      await click(button('Save changes'));
      const request = http.expectOne((r) => r.url === '/api/appointment-types/t1' && r.method === 'PATCH');
      expect(request.request.body).toEqual({ durationMinutes: 20 });
      request.flush(followUp);
      await render(fixture);
      reloadLists([khan, lee], [followUp]);
      await render(fixture);

      await click(buttons('Switch off').at(-1));
      const off = http.expectOne((r) => r.url === '/api/appointment-types/t1' && r.method === 'PATCH');
      expect(off.request.body).toEqual({ active: false });
      off.flush({ ...followUp, active: false });
      await render(fixture);
      reloadLists([khan, lee], [{ ...followUp, active: false }]);
      await render(fixture);
    });
  });

  describe('days off', () => {
    const upcoming: ProviderTimeOff = { id: 'o1', providerId: 'p1', startsAt: '2026-10-12T13:00:00.000Z', endsAt: '2026-10-12T21:00:00.000Z', reason: 'Conference', active: true };

    it('lists them in the practice’s time zone', async () => {
      await setup();
      await click(button('Days off'));
      http.expectOne('/api/providers/p1/time-off').flush([upcoming]);
      await render(fixture);
      expect(root().textContent).toContain('Mon 12 Oct, 9:00 AM to Mon 12 Oct, 5:00 PM'); // New York
      expect(root().textContent).toContain('Conference');
    });

    it('adds days off typed on the practice’s clock, as the exact instants', async () => {
      await setup();
      await click(button('Days off'));
      http.expectOne('/api/providers/p1/time-off').flush([]);
      await render(fixture);
      await type('off-start-date', '2026-12-24');
      await type('off-start-time', '13:00');
      await type('off-end-date', '2026-12-26');
      await type('off-end-time', '23:59');
      await type('off-reason', 'Holidays');
      await click(button('Add days off'));
      const request = http.expectOne((r) => r.url === '/api/providers/p1/time-off' && r.method === 'POST');
      expect(request.request.body).toEqual({ startsAt: '2026-12-24T18:00:00.000Z', endsAt: '2026-12-27T04:59:00.000Z', reason: 'Holidays' }); // New York is 5 hours behind in winter
      request.flush({ ...upcoming, id: 'o2', startsAt: '2026-12-24T18:00:00.000Z', endsAt: '2026-12-27T04:59:00.000Z', reason: 'Holidays' });
      await render(fixture);
      expect(root().textContent).toContain('Holidays');
    });

    it('will not add an end before the start', async () => {
      await setup();
      await click(button('Days off'));
      http.expectOne('/api/providers/p1/time-off').flush([]);
      await render(fixture);
      await type('off-start-date', '2026-12-26');
      await type('off-end-date', '2026-12-24');
      expect(button('Add days off')!.disabled).toBe(true);
      expect(root().textContent).toContain('The end must be after the start.');
    });

    it('cancels days off', async () => {
      await setup();
      await click(button('Days off'));
      http.expectOne('/api/providers/p1/time-off').flush([upcoming]);
      await render(fixture);
      await click(button('Cancel'));
      const request = http.expectOne((r) => r.url === '/api/provider-time-off/o1/cancel' && r.method === 'POST');
      request.flush({ ...upcoming, active: false });
      await render(fixture);
      expect(root().textContent).toContain('No upcoming days off.');
    });
  });
});
