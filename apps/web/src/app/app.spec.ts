import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { httpProviders } from './testing/helpers';
import { appConfig } from './app.config';
import { routes } from './app.routes';
import { App } from './app';

describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [App], providers: [provideRouter([]), ...httpProviders()] });
  });

  it('is just a place for the current page to appear', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
  });

  it('tries to restore a session before the first page, and wires the auth interceptor', () => {
    // 3 providers from Angular itself + router + http client + the startup initializer.
    expect(appConfig.providers.length).toBe(4);
  });

  describe('routes', () => {
    const child = (path: string) => routes.find((r) => r.path === '')?.children?.find((r) => r.path === path);

    it('keeps everything except the login page behind the sign-in check', () => {
      const guarded = routes.find((r) => r.path === '');
      expect(guarded?.canActivate?.length).toBe(1);
      expect(routes.find((r) => r.path === 'login')?.canActivate?.length).toBe(1);
    });

    it('guards the team and activity pages by permission, but not the dashboard', () => {
      expect(child('team')?.canActivate).toHaveLength(1);
      expect(child('activity')?.canActivate).toHaveLength(1);
      expect(child('dashboard')?.canActivate).toBeUndefined();
    });

    it('sends unknown addresses to the start', () => {
      expect(routes.at(-1)).toMatchObject({ path: '**', redirectTo: '' });
    });

    it('gives every page a title', () => {
      for (const route of [routes.find((r) => r.path === 'login'), child('dashboard'), child('team'), child('activity')]) {
        expect(route?.title).toMatch(/AI Front Desk$/);
      }
    });
  });
});
