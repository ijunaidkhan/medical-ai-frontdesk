import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { httpProviders, makeSession, render, tick } from '../../testing/helpers';
import { LoginPage } from './login.page';

describe('LoginPage', () => {
  let fixture: ComponentFixture<LoginPage>;
  let http: HttpTestingController;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;

  async function setup(returnUrl?: string) {
    TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        provideRouter([]),
        ...httpProviders(),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(returnUrl ? { returnUrl } : {}) } } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(LoginPage);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const input = (id: string) => root().querySelector<HTMLInputElement>(`#${id}`)!;
  const button = () => root().querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const alertText = () => root().querySelector('[role="alert"]')?.textContent?.trim() ?? null;

  function type(id: string, value: string) {
    input(id).value = value;
    input(id).dispatchEvent(new Event('input'));
  }

  async function submit() {
    root().querySelector('form')!.dispatchEvent(new Event('submit'));
    await render(fixture);
  }

  async function fillAndSubmit(email = 'jane@alpha.test', password = 'a long enough passphrase') {
    type('email', email);
    type('password', password);
    await submit();
  }

  afterEach(() => http.verify());

  it('offers an email field, a password field that hides what is typed, and a sign-in button', async () => {
    await setup();
    expect(root().querySelector('h1')?.textContent).toBe('Sign in');
    expect(input('email').type).toBe('email');
    expect(input('email').autocomplete).toBe('username');
    expect(input('password').type).toBe('password');
    expect(input('password').autocomplete).toBe('current-password');
    expect(button().textContent?.trim()).toBe('Sign in');
    expect(root().querySelector('label[for="email"]')).not.toBeNull();
    expect(root().querySelector('label[for="password"]')).not.toBeNull();
  });

  describe('checking the form before asking the server', () => {
    it('asks for both fields when nothing is entered, and sends nothing', async () => {
      await setup();
      await submit();

      expect(root().textContent).toContain('Enter your email address.');
      expect(root().textContent).toContain('Enter your password.');
      expect(input('email').getAttribute('aria-invalid')).toBe('true');
      expect(input('password').getAttribute('aria-invalid')).toBe('true');
      http.expectNone('/api/auth/login');
    });

    it('explains an email that is not an email', async () => {
      await setup();
      await fillAndSubmit('not-an-email');
      expect(root().textContent).toContain('Enter a valid email address.');
      http.expectNone('/api/auth/login');
    });

    it('links each message to its field for screen readers', async () => {
      await setup();
      await submit();
      expect(input('email').getAttribute('aria-describedby')).toBe('email-problem');
      expect(root().querySelector('#email-problem')?.textContent).toContain('Enter your email address.');
    });
  });

  describe('signing in', () => {
    it('sends the credentials and goes to the dashboard', async () => {
      await setup();
      await fillAndSubmit('  jane@alpha.test ', 'a long enough passphrase');

      const request = http.expectOne('/api/auth/login');
      expect(request.request.body).toEqual({ email: 'jane@alpha.test', password: 'a long enough passphrase' });
      request.flush(makeSession());
      await render(fixture);

      expect(navigateByUrl).toHaveBeenCalledWith('/dashboard');
    });

    it('returns to the page the person was going to', async () => {
      await setup('/team');
      await fillAndSubmit();
      http.expectOne('/api/auth/login').flush(makeSession());
      await render(fixture);
      expect(navigateByUrl).toHaveBeenCalledWith('/team');
    });

    it.each(['https://evil.example/phish', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
      'ignores a return address that leads elsewhere: %s',
      async (evil) => {
        await setup(evil);
        await fillAndSubmit();
        http.expectOne('/api/auth/login').flush(makeSession());
        await render(fixture);
        expect(navigateByUrl).toHaveBeenCalledWith('/dashboard');
      },
    );

    it('shows progress and ignores a second click while waiting', async () => {
      await setup();
      await fillAndSubmit();

      expect(button().disabled).toBe(true);
      expect(button().textContent?.trim()).toBe('Signing in…');
      await submit(); // an impatient second press
      http.expectOne('/api/auth/login').flush(makeSession()); // exactly one request was made
      await render(fixture);
      expect(button().disabled).toBe(false);
    });
  });

  describe('when sign-in fails', () => {
    async function failWith(status: number, body: object = {}) {
      await setup();
      await fillAndSubmit('jane@alpha.test', 'wrong password here');
      http.expectOne('/api/auth/login').flush(body, { status, statusText: 'x' });
      await render(fixture);
    }

    it('says the details are wrong, keeps the email, clears the password, and stays here', async () => {
      await failWith(401, { message: 'Invalid email or password' });
      expect(alertText()).toBe('Invalid email or password.');
      expect(input('email').value).toBe('jane@alpha.test');
      expect(input('password').value).toBe('');
      expect(navigateByUrl).not.toHaveBeenCalled();
      expect(button().disabled).toBe(false);
    });

    it('does not also complain that the password was left empty (the box was emptied on purpose)', async () => {
      await failWith(401);
      expect(alertText()).toBe('Invalid email or password.');
      expect(root().textContent).not.toContain('Enter your password.');
      expect(input('password').getAttribute('aria-invalid')).toBeNull();

      // ...but pressing Sign in again with nothing typed does ask for it.
      await submit();
      expect(root().textContent).toContain('Enter your password.');
    });

    it('says the service is not responding when the API is down behind the proxy (502)', async () => {
      await failWith(502);
      expect(alertText()).toBe('The service is not responding right now. Please try again in a moment.');
      expect(root().textContent).not.toContain('Enter your password.');
    });

    it('asks the person to wait when they have tried too often', async () => {
      await failWith(429);
      expect(alertText()).toMatch(/Too many requests/);
    });

    it('says so when the server cannot be reached', async () => {
      await setup();
      await fillAndSubmit();
      http.expectOne('/api/auth/login').error(new ProgressEvent('error'));
      await render(fixture);
      expect(alertText()).toMatch(/Cannot reach the server/);
    });

    it('does not reveal server details on an unexpected error', async () => {
      await failWith(500, { message: 'connection to postgres://user:hunter2@db refused' });
      expect(alertText()).toBe('Something went wrong. Please try again.');
      expect(root().textContent).not.toContain('hunter2');
    });

    it('lets the person try again, and clears the message on the next attempt', async () => {
      await failWith(401);
      expect(alertText()).not.toBeNull();

      type('password', 'a better passphrase!');
      await submit();
      expect(alertText()).toBeNull();
      http.expectOne('/api/auth/login').flush(makeSession());
      await render(fixture);
      expect(navigateByUrl).toHaveBeenCalled();
    });
  });

  describe('the show/hide password button', () => {
    it('reveals and hides the password, and tells assistive technology which it is doing', async () => {
      await setup();
      const toggle = () => root().querySelector<HTMLButtonElement>('.password-row button')!;
      expect(toggle().getAttribute('aria-pressed')).toBe('false');

      toggle().click();
      await render(fixture);
      expect(input('password').type).toBe('text');
      expect(toggle().getAttribute('aria-pressed')).toBe('true');
      expect(toggle().textContent?.trim()).toBe('Hide');

      toggle().click();
      await render(fixture);
      expect(input('password').type).toBe('password');
    });

    it('does not submit the form when pressed', async () => {
      await setup();
      root().querySelector<HTMLButtonElement>('.password-row button')!.click();
      await tick();
      http.expectNone('/api/auth/login');
    });
  });
});
