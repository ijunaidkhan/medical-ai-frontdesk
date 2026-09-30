import { HttpTestingController, type TestRequest } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { emptyBusinessHours, type AiSettings, type Role, type TransferTarget } from '@frontdesk/shared';
import { AuthService } from '../../core/auth/auth.service';
import { httpProviders, makeSession, PRACTICE_A, PRACTICE_B, render, signIn } from '../../testing/helpers';
import { AiSettingsPage } from './ai-settings.page';

const settings = (extra: Partial<AiSettings> = {}): AiSettings => ({
  enabled: false,
  greeting: 'Thank you for calling Alpha Clinic.',
  afterHoursAction: 'take_message',
  afterHoursTransferTargetId: null,
  emergencyMessage: 'If this is a medical emergency, hang up and call 911 now.',
  crisisMessage: 'If you are thinking about suicide, call or text 988 now.',
  urgentAction: 'urgent_task',
  urgentTransferTargetId: null,
  extraUrgentPhrases: [],
  businessHours: { ...emptyBusinessHours(), mon: [{ open: '09:00', close: '17:00' }] },
  updatedAt: '2026-09-30T10:00:00.000Z',
  ready: true,
  problems: [],
  ...extra,
});

const target = (id: string, label: string, extra: Partial<TransferTarget> = {}): TransferTarget => ({
  id,
  label,
  phone: '+14155550123',
  purpose: 'front_desk',
  active: true,
  ...extra,
});

describe('AiSettingsPage', () => {
  let fixture: ComponentFixture<AiSettingsPage>;
  let http: HttpTestingController;

  async function setup(options: { role?: Role; settings?: AiSettings; targets?: TransferTarget[] } = {}) {
    TestBed.configureTestingModule({ imports: [AiSettingsPage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: options.role ?? 'admin' }));
    fixture = TestBed.createComponent(AiSettingsPage);
    await render(fixture);
    http.expectOne('/api/ai/settings').flush(options.settings ?? settings());
    http.expectOne('/api/ai/transfer-targets').flush(options.targets ?? []);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const field = <T extends HTMLElement>(id: string) => root().querySelector<T>(`#${id}`)!;
  const button = (text: string) => [...root().querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  const type = async (id: string, value: string) => {
    const element = field<HTMLInputElement | HTMLTextAreaElement>(id);
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await render(fixture);
  };
  const patch = () => http.expectOne((r) => r.url === '/api/ai/settings' && r.method === 'PATCH');
  const alerts = () => [...root().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());

  afterEach(() => http.verify());

  describe('showing the settings', () => {
    it('shows what callers hear, including the crisis message and the notice that is always added', async () => {
      await setup();
      expect(field<HTMLTextAreaElement>('greeting').value).toBe('Thank you for calling Alpha Clinic.');
      expect(field<HTMLTextAreaElement>('emergency').value).toContain('911');
      expect(field<HTMLTextAreaElement>('crisis').value).toContain('988');
      expect(root().textContent).toContain('You are speaking with an automated AI assistant, not a person.');
      expect(root().querySelector('label[for="crisis"]')?.textContent).toContain('Crisis message');
    });

    it('lists what still blocks turning it on, and will not offer to turn it on', async () => {
      await setup({ settings: settings({ ready: false, problems: ['Write a greeting', 'Set your business hours'] }) });
      const items = [...root().querySelectorAll('.problems li')].map((li) => li.textContent);
      expect(items).toEqual(['Write a greeting', 'Set your business hours']);
      expect(button('Turn on')!.disabled).toBe(true);
    });

    it('shows the business hours per day, with closed days', async () => {
      await setup();
      expect((field<HTMLInputElement>('mon-open-0')).value).toBe('09:00');
      expect((field<HTMLInputElement>('mon-close-0')).value).toBe('17:00');
      expect(root().textContent).toContain('Closed');
      expect(root().textContent).toContain('America/New_York');
    });

    it('shows an error when the settings cannot be loaded', async () => {
      TestBed.configureTestingModule({ imports: [AiSettingsPage], providers: httpProviders() });
      http = TestBed.inject(HttpTestingController);
      await signIn(makeSession({ role: 'admin' }));
      fixture = TestBed.createComponent(AiSettingsPage);
      await render(fixture);
      http.expectOne('/api/ai/settings').flush({ message: 'nope' }, { status: 500, statusText: 'x' });
      http.expectOne('/api/ai/transfer-targets').flush([]);
      await render(fixture);
      expect(alerts()[0]).toBe('Something went wrong. Please try again.');
      expect(root().querySelector('form')).toBeNull();
    });
  });

  describe('changing the settings', () => {
    it('starts with Save disabled, enables it on a change, and sends only what changed', async () => {
      await setup();
      expect(button('Save changes')!.disabled).toBe(true);

      await type('greeting', 'Welcome to Alpha Clinic.');
      expect(button('Save changes')!.disabled).toBe(false);
      button('Save changes')!.click();
      await render(fixture);

      const request = patch();
      expect(request.request.body).toEqual({ greeting: 'Welcome to Alpha Clinic.' });
      request.flush(settings({ greeting: 'Welcome to Alpha Clinic.' }));
      await render(fixture);

      expect(root().querySelector('[role="status"].alert')?.textContent).toContain('Saved.');
      expect(button('Save changes')!.disabled).toBe(true);
    });

    it('sends the crisis message when it is changed', async () => {
      await setup();
      await type('crisis', 'Call or text 988 now.');
      button('Save changes')!.click();
      await render(fixture);
      const request = patch();
      expect(request.request.body).toEqual({ crisisMessage: 'Call or text 988 now.' });
      request.flush(settings({ crisisMessage: 'Call or text 988 now.' }));
    });

    it('turns one phrase per line into a list, ignoring blank lines and spaces', async () => {
      await setup();
      await type('phrases', '  manic episode \n\n  relapse risk\n');
      button('Save changes')!.click();
      await render(fixture);
      const request = patch();
      expect(request.request.body).toEqual({ extraUrgentPhrases: ['manic episode', 'relapse risk'] });
      request.flush(settings({ extraUrgentPhrases: ['manic episode', 'relapse risk'] }));
    });

    it('shows every reason when the API refuses the changes, and keeps what was typed', async () => {
      await setup();
      await type('greeting', 'Hello');
      button('Save changes')!.click();
      await render(fixture);
      patch().flush({ message: ['Write a greeting', 'Set your business hours'] }, { status: 409, statusText: 'Conflict' });
      await render(fixture);

      expect(alerts()[0]).toContain('Write a greeting');
      expect(alerts()[0]).toContain('Set your business hours');
      expect(field<HTMLTextAreaElement>('greeting').value).toBe('Hello');
      expect(button('Save changes')!.disabled).toBe(false);
    });

    it('asks for a number only when the choice needs one, and sends null when it is cleared', async () => {
      await setup({ targets: [target('t1', 'On-call nurse')], settings: settings({ urgentAction: 'transfer', urgentTransferTargetId: 't1' }) });
      expect(field('urgent-number')).not.toBeNull();
      expect(field('after-hours-number')).toBeNull();

      const select = field<HTMLSelectElement>('urgent-number');
      select.value = '';
      select.dispatchEvent(new Event('change'));
      await render(fixture);
      button('Save changes')!.click();
      await render(fixture);
      const request = patch();
      expect(request.request.body).toEqual({ urgentTransferTargetId: null });
      request.flush(settings({ urgentAction: 'transfer', urgentTransferTargetId: null }));
    });

    it('offers only active numbers to choose from', async () => {
      await setup({
        targets: [target('t1', 'On-call nurse'), target('t2', 'Old desk', { phone: '+14155550999', active: false })],
        settings: settings({ urgentAction: 'transfer_and_task' }),
      });
      const options = [...field<HTMLSelectElement>('urgent-number').options].map((o) => o.textContent?.trim());
      expect(options).toEqual(['Choose a number…', 'On-call nurse (+14155550123)']);
    });
  });

  describe('business hours', () => {
    it('adds a period, edits it, removes it, and can set a day to open all day', async () => {
      await setup();
      [...root().querySelectorAll('button')].find((b) => b.textContent?.includes('Add a period'))!.click();
      await render(fixture);
      expect(field('mon-open-1')).not.toBeNull();

      await type('mon-open-1', '18:00');
      await type('mon-close-1', '20:00');
      expect(button('Save changes')!.disabled).toBe(false);

      root().querySelectorAll<HTMLButtonElement>('button[aria-label="Remove this period on Monday"]')[1]!.click();
      await render(fixture);
      expect(field('mon-open-1')).toBeNull();
      expect(button('Save changes')!.disabled).toBe(true); // back to what is saved

      [...root().querySelectorAll('button')].filter((b) => b.textContent?.includes('Open all day'))[1]!.click(); // Tuesday
      await render(fixture);
      expect(field<HTMLInputElement>('tue-open-0').value).toBe('00:00');
      expect(field<HTMLInputElement>('tue-close-0').value).toBe('24:00');
    });

    it('stops at three periods a day', async () => {
      await setup();
      const addButtons = () => [...root().querySelectorAll('button')].filter((b) => b.textContent?.includes('Add a period'));
      expect(addButtons()).toHaveLength(7); // one per day
      addButtons()[0]!.click(); // Monday
      await render(fixture);
      addButtons()[0]!.click();
      await render(fixture);
      expect(field('mon-open-2')).not.toBeNull();
      expect(addButtons()).toHaveLength(6); // Monday is full; the other days can still add
    });

    it('accepts 24:00 as a closing time (a real browser time box could not show it)', async () => {
      await setup();
      await type('mon-open-0', '00:00');
      await type('mon-close-0', '24:00');
      expect(field<HTMLInputElement>('mon-close-0').type).toBe('text');
      expect(alerts()).toHaveLength(0);
      expect(button('Save changes')!.disabled).toBe(false);
    });

    it('explains a period that closes before it opens and does not allow saving it', async () => {
      await setup();
      await type('mon-open-0', '17:00');
      await type('mon-close-0', '09:00');
      expect(alerts().join(' ')).toMatch(/monday|mon/i);
      expect(button('Save changes')!.disabled).toBe(true);
    });
  });

  describe('turning the AI on and off', () => {
    it('turns it on when it is ready, and shows it as On', async () => {
      await setup();
      button('Turn on')!.click();
      await render(fixture);
      const request = patch();
      expect(request.request.body).toEqual({ enabled: true });
      request.flush(settings({ enabled: true }));
      await render(fixture);
      expect(root().querySelector('.badge')?.textContent?.trim()).toBe('On');
      expect(button('Turn off')).toBeDefined();
    });

    it('turns it off', async () => {
      await setup({ settings: settings({ enabled: true }) });
      button('Turn off')!.click();
      await render(fixture);
      const request = patch();
      expect(request.request.body).toEqual({ enabled: false });
      request.flush(settings({ enabled: false }));
      await render(fixture);
      expect(root().querySelector('.badge')?.textContent?.trim()).toBe('Off');
    });

    it('shows all the reasons if the API refuses to turn it on', async () => {
      await setup();
      button('Turn on')!.click();
      await render(fixture);
      patch().flush({ message: ['Write the crisis message callers will hear', 'Set your business hours'] }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(alerts()[0]).toContain('crisis message');
      expect(alerts()[0]).toContain('business hours');
      expect(root().querySelector('.badge')?.textContent?.trim()).toBe('Off');
    });

    it('will not switch anything while there are unsaved changes', async () => {
      await setup();
      await type('greeting', 'Something new');
      expect(button('Turn on')!.disabled).toBe(true);
      expect(root().textContent).toContain('Save your changes first.');

      // Not only the button: the action itself refuses, so no other code path can switch it by accident.
      await (fixture.componentInstance as unknown as { toggleEnabled(): Promise<void> }).toggleEnabled();
      http.expectNone((r) => r.url === '/api/ai/settings' && r.method === 'PATCH');
    });
  });

  describe('transfer numbers', () => {
    it('lists them with their purpose and whether they are in use', async () => {
      await setup({ targets: [target('t1', 'On-call nurse', { purpose: 'on_call' }), target('t2', 'Old desk', { active: false })] });
      const rows = [...root().querySelectorAll('tbody tr')].map((tr) => tr.textContent?.replace(/\s+/g, ' ').trim());
      expect(rows[0]).toContain('On-call nurse');
      expect(rows[0]).toContain('On-call clinician');
      expect(rows[0]).toContain('In use');
      expect(rows[1]).toContain('Turned off');
    });

    it('adds one, then clears the form', async () => {
      await setup();
      await type('new-label', ' Front desk ');
      await type('new-phone', '+14155550188');
      button('Add number')!.click();
      await render(fixture);
      const request = http.expectOne((r) => r.url === '/api/ai/transfer-targets' && r.method === 'POST');
      expect(request.request.body).toEqual({ label: 'Front desk', phone: '+14155550188', purpose: 'front_desk' });
      request.flush(target('t9', 'Front desk', { phone: '+14155550188' }));
      await render(fixture);

      expect(root().querySelectorAll('tbody tr')).toHaveLength(1);
      expect(field<HTMLInputElement>('new-label').value).toBe('');
    });

    it('will not add one without a name and a number', async () => {
      await setup();
      expect(button('Add number')!.disabled).toBe(true);
      await type('new-label', 'Front desk');
      expect(button('Add number')!.disabled).toBe(true);
    });

    it('shows the API’s reason when a number is refused', async () => {
      await setup();
      await type('new-label', 'Again');
      await type('new-phone', '+14155550188');
      button('Add number')!.click();
      await render(fixture);
      http.expectOne((r) => r.url === '/api/ai/transfer-targets' && r.method === 'POST').flush({ message: 'A transfer number with that phone number already exists' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(alerts()[0]).toBe('A transfer number with that phone number already exists');
    });

    it('turns a number off, or shows why it cannot be', async () => {
      await setup({ targets: [target('t1', 'On-call nurse')] });
      button('Turn off On-call nurse')!.click();
      await render(fixture);
      http.expectOne((r) => r.url === '/api/ai/transfer-targets/t1' && r.method === 'PATCH').flush({ message: 'The AI settings still use this number. Choose another one there first.' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(alerts()[0]).toContain('still use this number');
      expect(root().querySelector('tbody')?.textContent).toContain('In use');

      button('Turn off On-call nurse')!.click();
      await render(fixture);
      const request = http.expectOne((r) => r.url === '/api/ai/transfer-targets/t1' && r.method === 'PATCH');
      expect(request.request.body).toEqual({ active: false });
      request.flush(target('t1', 'On-call nurse', { active: false }));
      await render(fixture);
      expect(root().querySelector('tbody')?.textContent).toContain('Turned off');
    });
  });

  describe('someone who may only look (staff)', () => {
    beforeEach(async () => {
      await setup({ role: 'staff', targets: [target('t1', 'On-call nurse')] });
    });

    it('sees the settings but has nothing to change them with', () => {
      expect(field<HTMLTextAreaElement>('greeting').disabled).toBe(true);
      expect(field<HTMLTextAreaElement>('crisis').disabled).toBe(true);
      expect(field<HTMLInputElement>('mon-open-0').disabled).toBe(true);
      expect(button('Save changes')).toBeUndefined();
      expect(button('Turn on')).toBeUndefined();
      expect(button('Add number')).toBeUndefined();
      expect(button('Add a period')).toBeUndefined();
      expect(root().textContent).toContain('only an owner or administrator can change them');
      expect(root().querySelector('.add-number')).toBeNull();
    });
  });

  it('reloads for the new practice after a switch and ignores a late answer for the old one', async () => {
    const practices = [{ ...PRACTICE_A, role: 'admin' as const }, { ...PRACTICE_B, role: 'admin' as const }];
    TestBed.configureTestingModule({ imports: [AiSettingsPage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ practices }));
    fixture = TestBed.createComponent(AiSettingsPage);
    await render(fixture);
    const oldSettings: TestRequest = http.expectOne('/api/ai/settings'); // slow: not answered yet
    const oldTargets = http.expectOne('/api/ai/transfer-targets');

    const switching = TestBed.inject(AuthService).switchPractice(PRACTICE_B.id);
    http.expectOne('/api/auth/switch-practice').flush(makeSession({ practices, current: practices[1], token: 'beta' }));
    await switching;
    await render(fixture);

    http.expectOne('/api/ai/settings').flush(settings({ greeting: 'Beta Pediatrics here.' }));
    http.expectOne('/api/ai/transfer-targets').flush([]);
    await render(fixture);
    oldSettings.flush(settings({ greeting: 'Alpha greeting arriving late' }));
    oldTargets.flush([target('t1', 'Alpha desk')]);
    await render(fixture);

    expect(field<HTMLTextAreaElement>('greeting').value).toBe('Beta Pediatrics here.');
    expect(root().textContent).not.toContain('Alpha desk');
  });
});
