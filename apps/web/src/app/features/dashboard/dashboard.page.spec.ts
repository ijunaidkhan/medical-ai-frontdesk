import { HttpTestingController, type TestRequest } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AuditLogPage, MemberSummary, PracticeDetails, Role } from '@frontdesk/shared';
import { httpProviders, makeSession, PRACTICE_A, render, signIn } from '../../testing/helpers';
import { DashboardPage } from './dashboard.page';

const PRACTICE: PracticeDetails = {
  id: PRACTICE_A.id,
  name: PRACTICE_A.name,
  slug: 'alpha',
  timezone: 'America/New_York',
  phone: '+14155550123',
  status: 'active',
  createdAt: '2026-01-05T09:00:00.000Z',
};

const member = (n: number, role: Role, status: 'active' | 'suspended' = 'active'): MemberSummary => ({
  userId: `0190a1b2-c3d4-7e5f-8a9b-00000000010${n}`,
  email: `person${n}@alpha.test`,
  displayName: `Person ${n}`,
  role,
  status,
  joinedAt: '2026-01-06T09:00:00.000Z',
});

const AUDIT: AuditLogPage = {
  nextCursor: 'more',
  items: [
    { id: 'a1', action: 'auth.login.success', actorType: 'user', actorUserId: 'u1', actorName: 'Jane Smith', targetType: null, targetId: null, ip: '203.0.113.7', requestId: null, metadata: {}, occurredAt: '2026-09-29T18:05:00.000Z' },
    { id: 'a2', action: 'member.role_changed', actorType: 'user', actorUserId: 'u1', actorName: null, targetType: 'user', targetId: 'u2', ip: null, requestId: null, metadata: {}, occurredAt: '2026-09-29T17:00:00.000Z' },
    { id: 'a3', action: 'something.new', actorType: 'ai', actorUserId: null, actorName: null, targetType: null, targetId: null, ip: null, requestId: null, metadata: {}, occurredAt: '2026-09-29T16:00:00.000Z' },
  ],
};

describe('DashboardPage', () => {
  let fixture: ComponentFixture<DashboardPage>;
  let http: HttpTestingController;

  /** The appointments request today's card made (answered here with ppointments), if the role may see the schedule. */
  let todayRequest: TestRequest | undefined;

  async function setup(role: Role, appointments: unknown[] = []) {
    TestBed.configureTestingModule({ imports: [DashboardPage], providers: [provideRouter([]), ...httpProviders()] });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role }));
    fixture = TestBed.createComponent(DashboardPage);
    await render(fixture);
    todayRequest = http.match((r) => r.url === '/api/appointments')[0];
    todayRequest?.flush(appointments);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const audit = () => http.expectOne((r) => r.url === '/api/audit-logs' && r.params.get('limit') === '5');
  const alertTexts = () => [...root().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.trim());

  afterEach(() => http.verify());

  describe('an owner', () => {
    async function ownerWithData() {
      await setup('owner');
      http.expectOne('/api/practice').flush(PRACTICE);
      http.expectOne('/api/members').flush([member(1, 'owner'), member(2, 'staff'), member(3, 'staff'), member(4, 'viewer', 'suspended')]);
      audit().flush(AUDIT);
      await render(fixture);
    }

    it('shows the practice details from the API, and "Not set" for a missing phone', async () => {
      await ownerWithData();
      for (const expected of [PRACTICE.name, 'alpha', 'America/New_York', '+14155550123', 'active']) {
        expect(text()).toContain(expected);
      }

      http.verify();
      TestBed.resetTestingModule();
      await setup('owner');
      http.expectOne('/api/practice').flush({ ...PRACTICE, phone: null });
      http.expectOne('/api/members').flush([]);
      audit().flush({ items: [], nextCursor: null });
      await render(fixture);
      expect(text()).toContain('Not set');
    });

    it('describes their access in plain words, from their role', async () => {
      await ownerWithData();
      expect(text()).toContain('Owner');
      for (const line of ['View practice details', 'Change practice details', 'See who is on the team', 'Manage team roles and access', 'Review the activity log']) {
        expect(text()).toContain(line);
      }
    });

    it('counts the active team by role (suspended people are not counted)', async () => {
      await ownerWithData();
      const counts = [...root().querySelectorAll('.counts li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
      expect(counts).toEqual(['1 Owner', '2 Staff']); // the suspended viewer is left out; "Staff" is already plural
    });

    it('shows recent activity in readable words with the practice’s time zone, and links to all of it', async () => {
      await ownerWithData();
      const rows = [...root().querySelectorAll('.activity li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain('Signed in');
      expect(rows[0]).toContain('Jane Smith');
      expect(rows[0]).toContain('14:05'); // 18:05 UTC in New York
      expect(rows[1]).toContain('Team member role changed');
      expect(rows[1]).toContain('Unknown user');
      expect(rows[2]).toContain('something.new'); // an event with no friendly name shows as is
      expect(rows[2]).toContain('AI receptionist'); // and an action by the AI is named as the AI
      expect(root().querySelector('a[href="/activity"]')).not.toBeNull();
      expect(root().querySelector('a[href="/team"]')).not.toBeNull();
    });

    it('says so when nothing has been recorded', async () => {
      await setup('owner');
      http.expectOne('/api/practice').flush(PRACTICE);
      http.expectOne('/api/members').flush([]);
      audit().flush({ items: [], nextCursor: null });
      await render(fixture);
      expect(text()).toContain('Nothing has been recorded yet.');
    });

    it('shows a loading message until the data arrives', async () => {
      await setup('owner');
      expect(root().querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
      expect(text()).toContain('Loading…');
      http.expectOne('/api/practice').flush(PRACTICE);
      http.expectOne('/api/members').flush([]);
      audit().flush({ items: [], nextCursor: null });
    });

    it('reports each failing part separately, without hiding the parts that worked', async () => {
      await setup('owner');
      http.expectOne('/api/practice').flush(PRACTICE);
      http.expectOne('/api/members').flush({ message: 'connection to postgres://user:hunter2@db refused' }, { status: 500, statusText: 'x' });
      audit().flush({ message: 'Invalid cursor' }, { status: 400, statusText: 'Bad Request' });
      await render(fixture);

      expect(text()).toContain(PRACTICE.name); // still shown
      expect(alertTexts()).toEqual(['Something went wrong. Please try again.', 'Invalid cursor']);
      expect(text()).not.toContain('hunter2');
    });
  });

  describe('today', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-05T15:00:00Z')); // Monday 11:00 in New York
    });
    afterEach(() => vi.useRealTimers());

    it('counts today’s booked appointments on the practice’s calendar, and links to the schedule', async () => {
      await setup('staff', [{ id: 'a1' }, { id: 'a2' }]);
      expect(todayRequest!.request.params.get('from')).toBe('2026-10-05T04:00:00.000Z');
      expect(todayRequest!.request.params.get('to')).toBe('2026-10-06T04:00:00.000Z');
      expect(todayRequest!.request.params.get('status')).toBe('booked');
      http.expectOne('/api/practice').flush(PRACTICE);
      http.expectOne('/api/members').flush([]);
      await render(fixture);
      expect(root().querySelector('#today-heading')?.parentElement?.textContent?.replace(/\s+/g, ' ')).toContain('2 appointments');
      expect(root().querySelector('a[href="/schedule"]')).not.toBeNull();
    });

    it('says "1 appointment", not "1 appointments"', async () => {
      await setup('staff', [{ id: 'a1' }]);
      http.expectOne('/api/practice').flush(PRACTICE);
      http.expectOne('/api/members').flush([]);
      await render(fixture);
      const card = root().querySelector('#today-heading')?.parentElement?.textContent ?? '';
      expect(card).toContain('1 appointment');
      expect(card).not.toContain('appointments');
    });
  });

  describe('what each role is allowed to load', () => {
    const requestedBy = async (role: Role) => {
      await setup(role);
      const practiceRequest = http.expectOne('/api/practice');
      const others: TestRequest[] = [];
      for (const matcher of [(r: { url: string }) => r.url === '/api/members', (r: { url: string }) => r.url === '/api/audit-logs']) {
        others.push(...http.match(matcher));
      }
      practiceRequest.flush(PRACTICE);
      others.forEach((request) => request.flush(request.request.url === '/api/members' ? [] : { items: [], nextCursor: null }));
      await render(fixture);
      return [...(todayRequest ? ['/api/appointments'] : []), ...others.map((request) => request.request.url)].sort();
    };

    it.each<[Role, string[]]>([
      ['owner', ['/api/appointments', '/api/audit-logs', '/api/members']],
      ['admin', ['/api/appointments', '/api/audit-logs', '/api/members']],
      ['staff', ['/api/appointments', '/api/members']],
      ['viewer', []],
    ])('%s asks for %j besides the practice', async (role, expected) => {
      expect(await requestedBy(role)).toEqual(expected);
    });

    it('a viewer sees no team or activity sections at all', async () => {
      await requestedBy('viewer');
      expect(root().querySelector('#team-heading')).toBeNull();
      expect(root().querySelector('#today-heading')).toBeNull();
      expect(root().querySelector('#activity-heading')).toBeNull();
      expect(text()).toContain('Viewer');
      expect(root().querySelectorAll('.allowed li')).toHaveLength(1);
    });

    it('staff see the team but not the activity log', async () => {
      await requestedBy('staff');
      expect(root().querySelector('#team-heading')).not.toBeNull();
      expect(root().querySelector('#activity-heading')).toBeNull();
    });
  });
});
