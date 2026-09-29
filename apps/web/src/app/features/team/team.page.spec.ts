import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { MemberSummary } from '@frontdesk/shared';
import { httpProviders, makeSession, render, signIn } from '../../testing/helpers';
import { TeamPage } from './team.page';

const MEMBERS: MemberSummary[] = [
  { userId: 'u1', email: 'jane@alpha.test', displayName: 'Jane Smith', role: 'owner', status: 'active', joinedAt: '2026-01-05T09:00:00.000Z' },
  { userId: 'u2', email: 'bob@alpha.test', displayName: 'Bob Jones', role: 'staff', status: 'suspended', joinedAt: '2026-03-10T23:30:00.000Z' },
  { userId: 'u3', email: 'amy@alpha.test', displayName: 'Amy Lee', role: 'admin', status: 'active', joinedAt: '2026-02-01T09:00:00.000Z' },
];

describe('TeamPage', () => {
  let fixture: ComponentFixture<TeamPage>;
  let http: HttpTestingController;

  async function setup() {
    TestBed.configureTestingModule({ imports: [TeamPage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: 'staff' }));
    fixture = TestBed.createComponent(TeamPage);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const rows = () => [...root().querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim()));

  afterEach(() => http.verify());

  it('lists everyone on the team with their role and status', async () => {
    await setup();
    http.expectOne('/api/members').flush(MEMBERS);
    await render(fixture);

    expect(rows().map((row) => row.slice(0, 4))).toEqual([
      ['Jane Smith', 'jane@alpha.test', 'Owner', 'active'],
      ['Bob Jones', 'bob@alpha.test', 'Staff', 'suspended'],
      ['Amy Lee', 'amy@alpha.test', 'Administrator', 'active'],
    ]);
  });

  it('highlights suspended members', async () => {
    await setup();
    http.expectOne('/api/members').flush(MEMBERS);
    await render(fixture);
    const badges = [...root().querySelectorAll('tbody .badge')].map((b) => b.classList.contains('badge-warn'));
    expect(badges).toEqual([false, true, false]);
  });

  it('shows join dates in the practice’s time zone', async () => {
    await setup();
    http.expectOne('/api/members').flush(MEMBERS);
    await render(fixture);
    expect(rows()[1]?.[4]).toMatch(/^10 /); // 23:30 UTC is still the 10th in New York
  });

  it('is an accessible table with a caption and column headers', async () => {
    await setup();
    http.expectOne('/api/members').flush(MEMBERS);
    await render(fixture);
    expect(root().querySelector('caption')?.textContent).toBe('Team members');
    expect([...root().querySelectorAll('th[scope="col"]')].map((th) => th.textContent)).toEqual(['Name', 'Email', 'Role', 'Status', 'Joined']);
  });

  it('shows a loading message, then an error message if the request fails', async () => {
    await setup();
    expect(root().textContent).toContain('Loading…');
    http.expectOne('/api/members').flush({ message: 'You do not have permission to do that' }, { status: 403, statusText: 'Forbidden' });
    await render(fixture);
    expect(root().querySelector('[role="alert"]')?.textContent?.trim()).toBe('You do not have permission to do that');
    expect(root().querySelector('table')).toBeNull();
  });
});
