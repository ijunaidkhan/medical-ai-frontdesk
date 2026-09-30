import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { AuditLogEntry, AuditLogPage } from '@frontdesk/shared';
import { AuthService } from '../../core/auth/auth.service';
import { httpProviders, makeSession, PRACTICE_A, PRACTICE_B, render, signIn } from '../../testing/helpers';
import { ActivityPage } from './activity.page';

const entry = (id: string, action: string, extra: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id,
  action,
  actorType: 'user',
  actorUserId: 'u1',
  actorName: 'Jane Smith',
  targetType: null,
  targetId: null,
  ip: '203.0.113.7',
  requestId: null,
  metadata: {},
  occurredAt: '2026-09-29T18:05:00.000Z',
  ...extra,
});

describe('ActivityPage', () => {
  let fixture: ComponentFixture<ActivityPage>;
  let http: HttpTestingController;

  async function setup(practices = [{ ...PRACTICE_A, role: 'admin' as const }]) {
    TestBed.configureTestingModule({ imports: [ActivityPage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ practices }));
    fixture = TestBed.createComponent(ActivityPage);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const firstPage = () => http.expectOne((r) => r.url === '/api/audit-logs' && r.params.get('limit') === '25' && !r.params.has('cursor'));
  const pageAfter = (cursor: string) => http.expectOne((r) => r.url === '/api/audit-logs' && r.params.get('cursor') === cursor);
  const rows = () => [...root().querySelectorAll('tbody tr')].map((tr) => tr.textContent?.replace(/\s+/g, ' ').trim());
  const loadMoreButton = () => [...root().querySelectorAll('button')].find((b) => b.textContent?.includes('Load more'));

  afterEach(() => http.verify());

  it('shows events newest first, in words, with who, where from, and the practice’s local time', async () => {
    await setup();
    firstPage().flush({
      items: [
        entry('a1', 'auth.login.success'),
        entry('a2', 'auth.login.failed', { actorName: null, ip: null, metadata: { reason: 'invalid_password' } }),
      ],
      nextCursor: null,
    } satisfies AuditLogPage);
    await render(fixture);

    const [first, second] = rows();
    expect(first).toContain('Signed in');
    expect(first).toContain('Jane Smith');
    expect(first).toContain('203.0.113.7');
    expect(first).toContain('14:05'); // 18:05 UTC in New York
    expect(second).toContain('Failed sign-in attempt');
    expect(second).toContain('(invalid password)');
    expect(second).toContain('Unknown user');
    expect(second).toContain('—');
  });

  it('names the AI receptionist and the system as such, never as an unknown user', async () => {
    await setup();
    firstPage().flush({
      items: [
        entry('a1', 'task.created', { actorType: 'ai', actorUserId: null, actorName: null }),
        entry('a2', 'auth.login.failed', { actorType: 'system', actorUserId: null, actorName: null }),
        entry('a3', 'auth.login.failed', { actorType: 'user', actorUserId: null, actorName: null }),
      ],
      nextCursor: null,
    } satisfies AuditLogPage);
    await render(fixture);

    const [ai, system, unknown] = rows();
    expect(ai).toContain('AI receptionist');
    expect(system).toContain('System');
    expect(unknown).toContain('Unknown user');
  });

  it('says so when there is nothing to show', async () => {
    await setup();
    firstPage().flush({ items: [], nextCursor: null });
    await render(fixture);
    expect(root().textContent).toContain('Nothing has been recorded yet.');
    expect(root().querySelector('table')).toBeNull();
    expect(loadMoreButton()).toBeUndefined();
  });

  describe('loading more', () => {
    it('fetches the next page with the cursor, adds it below, and stops offering more at the end', async () => {
      await setup();
      firstPage().flush({ items: [entry('a1', 'auth.login.success')], nextCursor: 'cursor-1' });
      await render(fixture);
      expect(rows()).toHaveLength(1);
      expect(loadMoreButton()).toBeDefined();

      loadMoreButton()!.click();
      await render(fixture);
      pageAfter('cursor-1').flush({ items: [entry('a2', 'auth.logout')], nextCursor: 'cursor-2' });
      await render(fixture);
      expect(rows()).toHaveLength(2);
      expect(rows()[1]).toContain('Signed out');

      loadMoreButton()!.click();
      await render(fixture);
      pageAfter('cursor-2').flush({ items: [entry('a3', 'practice.updated')], nextCursor: null });
      await render(fixture);
      expect(rows()).toHaveLength(3);
      expect(loadMoreButton()).toBeUndefined();
    });

    it('hides the button and shows progress while a page is loading', async () => {
      await setup();
      firstPage().flush({ items: [entry('a1', 'auth.login.success')], nextCursor: 'cursor-1' });
      await render(fixture);
      loadMoreButton()!.click();
      await render(fixture);

      expect(loadMoreButton()).toBeUndefined();
      expect(root().querySelector('[role="status"]')?.textContent).toContain('Loading');
      pageAfter('cursor-1').flush({ items: [], nextCursor: null });
    });

    it('keeps what is already shown, and lets the person retry, when a later page fails', async () => {
      await setup();
      firstPage().flush({ items: [entry('a1', 'auth.login.success')], nextCursor: 'cursor-1' });
      await render(fixture);
      loadMoreButton()!.click();
      await render(fixture);
      pageAfter('cursor-1').flush({ message: 'x' }, { status: 500, statusText: 'x' });
      await render(fixture);

      expect(root().querySelector('[role="alert"]')?.textContent?.trim()).toBe('Something went wrong. Please try again.');
      expect(rows()).toHaveLength(1);
      expect(loadMoreButton()).toBeDefined();
    });
  });

  it('shows an error when the first page cannot be loaded', async () => {
    await setup();
    firstPage().flush({ message: 'You do not have permission to do that' }, { status: 403, statusText: 'Forbidden' });
    await render(fixture);
    expect(root().querySelector('[role="alert"]')?.textContent?.trim()).toBe('You do not have permission to do that');
    expect(root().querySelector('table')).toBeNull();
    expect(root().textContent).not.toContain('Nothing has been recorded yet.');
  });

  it('starts again for the new practice on a switch, and ignores a late answer for the old one', async () => {
    const practices = [{ ...PRACTICE_A, role: 'admin' as const }, { ...PRACTICE_B, role: 'admin' as const }];
    await setup(practices);
    const oldPracticeRequest = firstPage(); // slow: not answered yet

    const switching = TestBed.inject(AuthService).switchPractice(PRACTICE_B.id);
    http.expectOne('/api/auth/switch-practice').flush(makeSession({ practices, current: practices[1], token: 'beta' }));
    await switching;
    await render(fixture);

    firstPage().flush({ items: [entry('b1', 'practice.updated')], nextCursor: null }); // Beta's answer
    await render(fixture);
    oldPracticeRequest.flush({ items: [entry('a1', 'auth.login.success')], nextCursor: 'stale' }); // Alpha's, arriving late
    await render(fixture);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Practice details changed');
    expect(root().textContent).not.toContain('Signed in');
    expect(loadMoreButton()).toBeUndefined(); // the stale cursor was not adopted
  });
});
