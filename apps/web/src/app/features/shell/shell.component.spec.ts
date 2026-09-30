import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { AuthSession, Role } from '@frontdesk/shared';
import { AuthService } from '../../core/auth/auth.service';
import { httpProviders, makeSession, PRACTICE_A, PRACTICE_B, render, signIn } from '../../testing/helpers';
import { ShellComponent } from './shell.component';

describe('ShellComponent', () => {
  let fixture: ComponentFixture<ShellComponent>;
  let http: HttpTestingController;
  let router: Router;
  let navigate: ReturnType<typeof vi.spyOn>;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;

  async function setup(session: AuthSession = makeSession()) {
    TestBed.configureTestingModule({ imports: [ShellComponent], providers: [provideRouter([]), ...httpProviders()] });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    await signIn(session);
    fixture = TestBed.createComponent(ShellComponent);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const navLabels = () => [...root().querySelectorAll('nav a')].map((a) => a.textContent?.trim());
  const select = () => root().querySelector<HTMLSelectElement>('#practice-switch');
  const alertText = () => root().querySelector('[role="alert"]')?.textContent?.trim() ?? null;

  afterEach(() => http.verify());

  describe('who is signed in', () => {
    it('shows the person, their role and the practice name', async () => {
      await setup(makeSession({ role: 'admin' }));
      expect(root().textContent).toContain('Jane Smith');
      expect(root().querySelector('.badge')?.textContent).toBe('Administrator');
      expect(root().querySelector('.practice-name')?.textContent).toBe(PRACTICE_A.name);
      expect(select()).toBeNull(); // only one practice: nothing to switch
    });

    it('has a skip link and a labelled main landmark for keyboard and screen-reader users', async () => {
      await setup();
      expect(root().querySelector('a.skip-link')?.getAttribute('href')).toBe('#main');
      expect(root().querySelector('main#main')).not.toBeNull();
      expect(root().querySelector('nav')?.getAttribute('aria-label')).toBe('Main');
    });
  });

  describe('navigation follows the role', () => {
    it.each<[Role, string[]]>([
      ['owner', ['Dashboard', 'Team', 'AI receptionist', 'Activity']],
      ['admin', ['Dashboard', 'Team', 'AI receptionist', 'Activity']],
      ['staff', ['Dashboard', 'Team', 'AI receptionist']],
      ['viewer', ['Dashboard']],
    ])('%s sees %j', async (role, expected) => {
      await setup(makeSession({ role }));
      expect(navLabels()).toEqual(expected);
    });
  });

  describe('switching practice', () => {
    const two = () => makeSession({ practices: [{ ...PRACTICE_A, role: 'admin' }, PRACTICE_B] });

    it('offers every practice the person belongs to, with the current one selected', async () => {
      await setup(two());
      const options = [...select()!.options].map((o) => [o.textContent?.trim(), o.selected]);
      expect(options).toEqual([[PRACTICE_A.name, true], [PRACTICE_B.name, false]]);
      expect(navLabels()).toContain('Activity'); // admin in Alpha
    });

    it('moves to the other practice, updates the role and menu, and lands on the dashboard', async () => {
      await setup(two());
      select()!.value = PRACTICE_B.id;
      select()!.dispatchEvent(new Event('change'));
      await render(fixture);

      const request = http.expectOne('/api/auth/switch-practice');
      expect(request.request.body).toEqual({ practiceId: PRACTICE_B.id });
      request.flush(makeSession({ practices: [{ ...PRACTICE_A, role: 'admin' }, PRACTICE_B], current: PRACTICE_B, token: 'beta' }));
      await render(fixture);

      expect(navigateByUrl).toHaveBeenCalledWith('/dashboard');
      expect(root().querySelector('.badge')?.textContent).toBe('Viewer');
      expect(navLabels()).toEqual(['Dashboard']); // only a viewer in Beta
      expect(select()!.value).toBe(PRACTICE_B.id);
    });

    it('does nothing when the current practice is chosen again', async () => {
      await setup(two());
      select()!.value = PRACTICE_A.id;
      select()!.dispatchEvent(new Event('change'));
      await render(fixture);
      http.expectNone('/api/auth/switch-practice');
    });

    it('stays put, reverts the menu and says why when the switch is refused', async () => {
      await setup(two());
      select()!.value = PRACTICE_B.id;
      select()!.dispatchEvent(new Event('change'));
      await render(fixture);
      http.expectOne('/api/auth/switch-practice').flush({ message: 'You do not have access to that practice' }, { status: 403, statusText: 'Forbidden' });
      await render(fixture);

      expect(alertText()).toBe('You do not have access to that practice');
      expect(select()!.value).toBe(PRACTICE_A.id);
      expect(navigateByUrl).not.toHaveBeenCalled();
      expect(TestBed.inject(AuthService).practiceId()).toBe(PRACTICE_A.id);
    });
  });

  describe('signing out', () => {
    it('ends the session on the server, then goes to the login page without a return address', async () => {
      await setup();
      root().querySelector<HTMLButtonElement>('.person button')!.click();
      await render(fixture);

      const request = http.expectOne('/api/auth/logout');
      expect(request.request.method).toBe('POST');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await render(fixture);

      expect(navigateByUrl).toHaveBeenCalledWith('/login');
      expect(navigate).not.toHaveBeenCalled(); // no "come back to this page" after a deliberate sign-out
      expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
    });
  });

  describe('when the session ends without the person asking (for example it expired)', () => {
    it('returns to the login page and remembers where they were', async () => {
      await setup();
      vi.spyOn(router, 'url', 'get').mockReturnValue('/team');

      const pending = TestBed.inject(AuthService).logout(); // stands in for any way the session can end
      http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
      await pending;
      await render(fixture);

      expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: '/team' } });
    });
  });
});
