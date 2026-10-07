import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { MemberSummary, Role, Task } from '@frontdesk/shared';
import { httpProviders, makeSession, render, signIn } from '../../testing/helpers';
import { TasksPage } from './tasks.page';

const ME = '0190a1b2-c3d4-7e5f-8a9b-0000000000aa'; // the signed-in user in makeSession
const OMAR = '0190a1b2-c3d4-7e5f-8a9b-0000000000bb';

const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id,
  type: 'callback',
  status: 'open',
  priority: 'normal',
  title,
  details: null,
  contactName: null,
  contactPhone: null,
  createdBy: { kind: 'user', person: { userId: OMAR, name: 'Omar Raza' } },
  assignedTo: null,
  conversationId: null,
  dueAt: null,
  completedAt: null,
  createdAt: '2026-10-05T13:00:00.000Z',
  updatedAt: '2026-10-05T13:00:00.000Z',
  ...extra,
});
const member = (userId: string, displayName: string): MemberSummary => ({ userId, email: `${userId}@x.test`, displayName, role: 'staff', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' });

const fromAi = task('t1', 'Possible medical emergency', {
  priority: 'urgent',
  createdBy: { kind: 'ai' },
  conversationId: 'c1',
  contactName: 'Sara Ali',
  contactPhone: '+14155550111',
  details: 'Raised by the safety rules.',
});
const normal = task('t2', 'Call back about parking');

describe('TasksPage', () => {
  let fixture: ComponentFixture<TasksPage>;
  let http: HttpTestingController;

  async function setup(options: { role?: Role; tasks?: Task[]; cursor?: string | null } = {}) {
    TestBed.configureTestingModule({ imports: [TasksPage], providers: [provideRouter([]), ...httpProviders()] });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: options.role ?? 'staff' }));
    fixture = TestBed.createComponent(TasksPage);
    await render(fixture);
    const list = http.expectOne((r) => r.url === '/api/tasks' && r.method === 'GET');
    expect(list.request.params.get('status')).toBe('active');
    list.flush({ items: options.tasks ?? [fromAi, normal], nextCursor: options.cursor ?? null });
    http.match('/api/members').forEach((request) => request.flush([member(ME, 'Jane Smith'), member(OMAR, 'Omar Raza')]));
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent!.replace(/\s+/g, ' ');
  const cards = () => [...root().querySelectorAll<HTMLElement>('li.task')];
  const button = (label: string, within: HTMLElement = root()) => [...within.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim().startsWith(label));
  const click = async (element: HTMLElement | undefined) => {
    element!.click();
    await render(fixture);
  };
  const choose = async (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await render(fixture);
  };
  const type = async (id: string, value: string) => {
    const element = root().querySelector<HTMLInputElement>(`#${id}`)!;
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await render(fixture);
  };
  const patch = (id: string) => http.expectOne((r) => r.url === `/api/tasks/${id}` && r.method === 'PATCH');

  afterEach(() => http.verify());

  describe('the queue', () => {
    it('shows each task with what staff need to act on it', async () => {
      await setup();
      const [first, second] = cards();
      expect(first!.classList).toContain('urgent');
      expect(first!.textContent).toContain('Urgent');
      expect(first!.textContent).toContain('From the AI receptionist');
      expect(first!.querySelector('a[href="tel:+14155550111"]')?.textContent).toBe('+14155550111');
      expect(first!.querySelector('a[href="/conversations/c1"]')?.textContent).toContain('See the conversation');
      expect(second!.textContent).toContain('Added by Omar Raza');
      expect(second!.textContent).toContain('Not assigned');
      expect(second!.textContent).toContain('5 Oct 2026, 09:00'); // in New York
    });

    it('filters by status and by who it is assigned to', async () => {
      await setup();
      await choose(root().querySelector<HTMLSelectElement>('#filter-status')!, 'done');
      let request = http.expectOne((r) => r.url === '/api/tasks');
      expect(request.request.params.get('status')).toBe('done');
      request.flush({ items: [], nextCursor: null });
      await render(fixture);
      expect(text()).toContain('No tasks here.');

      await choose(root().querySelector<HTMLSelectElement>('#filter-assignee')!, 'me');
      request = http.expectOne((r) => r.url === '/api/tasks');
      expect(request.request.params.get('assignee')).toBe('me');
      expect(request.request.params.get('status')).toBe('done');
      request.flush({ items: [], nextCursor: null });
      await render(fixture);
    });

    it('ignores a slow answer for a filter that was already changed', async () => {
      await setup();
      await choose(root().querySelector<HTMLSelectElement>('#filter-status')!, 'done');
      const slow = http.expectOne((r) => r.url === '/api/tasks');
      await choose(root().querySelector<HTMLSelectElement>('#filter-status')!, 'all');
      http.expectOne((r) => r.url === '/api/tasks' && r.params.get('status') === 'all').flush({ items: [task('t7', 'From the all list')], nextCursor: null });
      await render(fixture);
      slow.flush({ items: [task('t8', 'Late done list', { status: 'done' })], nextCursor: null });
      await render(fixture);
      expect(text()).toContain('From the all list');
      expect(text()).not.toContain('Late done list');
    });

    it('loads more with the page position the server gave', async () => {
      await setup({ cursor: 'next-1' });
      await click(button('Load more'));
      const request = http.expectOne((r) => r.url === '/api/tasks');
      expect(request.request.params.get('cursor')).toBe('next-1');
      request.flush({ items: [task('t3', 'Third')], nextCursor: null });
      await render(fixture);
      expect(cards()).toHaveLength(3);
      expect(button('Load more')).toBeUndefined();
    });
  });

  describe('working the queue', () => {
    it('offers only the allowed moves: Start, Mark done or Cancel for an open task', async () => {
      await setup();
      const labels = [...cards()[1]!.querySelectorAll('.task-actions button')].map((b) => b.textContent!.replace(/\s+/g, ' ').split(':')[0]!.trim());
      expect(labels).toEqual(['Start', 'Mark done', 'Cancel task', 'Assign to me', 'Change']);
    });

    it('marks a task done; it leaves the to-do list with a notice', async () => {
      await setup();
      await click(button('Mark done', cards()[1]));
      const request = patch('t2');
      expect(request.request.body).toEqual({ status: 'done' });
      request.flush({ ...normal, status: 'done' });
      await render(fixture);
      expect(cards()).toHaveLength(1);
      expect(text()).toContain('“Call back about parking”: done.');
    });

    it('starts a task and keeps it in the list', async () => {
      await setup();
      await click(button('Start', cards()[1]));
      patch('t2').flush({ ...normal, status: 'in_progress' });
      await render(fixture);
      expect(cards()[1]!.textContent).toContain('In progress');
    });

    it('a finished task can only be reopened, not changed', async () => {
      await setup({ tasks: [task('t9', 'Done one', { status: 'done' })] });
      const labels = [...cards()[0]!.querySelectorAll('.task-actions button')].map((b) => b.textContent!.split(':')[0]!.trim());
      expect(labels).toEqual(['Reopen']);
      expect(cards()[0]!.textContent).toContain('Reopen it to change it.');
    });

    it('assigns to me, and to someone else', async () => {
      await setup();
      await click(button('Assign to me', cards()[1]));
      let request = patch('t2');
      expect(request.request.body).toEqual({ assignedTo: ME });
      request.flush({ ...normal, assignedTo: { userId: ME, name: 'Jane Smith' } });
      await render(fixture);
      expect(cards()[1]!.textContent).toContain('Assigned to Jane Smith');
      expect(button('Assign to me', cards()[1])).toBeUndefined();

      await choose(cards()[1]!.querySelector<HTMLSelectElement>('select.assign')!, '');
      request = patch('t2');
      expect(request.request.body).toEqual({ assignedTo: null });
      request.flush(normal);
      await render(fixture);
    });

    it('shows the server’s reason when a change is refused, on that task', async () => {
      await setup();
      await click(button('Mark done', cards()[1]));
      patch('t2').flush({ message: 'Reopen the task before editing it' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(cards()[1]!.querySelector('[role="alert"]')?.textContent).toContain('Reopen the task before editing it');
    });
  });

  describe('adding and changing', () => {
    it('adds a task, sending only what was filled in', async () => {
      await setup();
      await click(button('New task'));
      expect(button('Add task')!.disabled).toBe(true);
      await type('task-title', 'Ask about insurance');
      await type('task-phone', '+923001234567');
      await click(button('Add task'));
      const request = http.expectOne((r) => r.url === '/api/tasks' && r.method === 'POST');
      expect(request.request.body).toEqual({ type: 'callback', title: 'Ask about insurance', priority: 'normal', contactPhone: '+923001234567' });
      request.flush(task('t5', 'Ask about insurance'));
      await render(fixture);
      expect(cards()[0]!.textContent).toContain('Ask about insurance');
      expect(text()).toContain('Task added');
    });

    it('will not add a task with a phone number without the country code', async () => {
      await setup();
      await click(button('New task'));
      await type('task-title', 'Call me');
      await type('task-phone', '03001234567');
      expect(button('Add task')!.disabled).toBe(true);
      expect(text()).toContain('country code');
    });

    it('marking a task urgent sends only that', async () => {
      await setup();
      await click(button('Change', cards()[1]));
      const box = root().querySelector<HTMLInputElement>('form.editor input[type="checkbox"]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await render(fixture);
      await click(button('Save changes'));
      const request = patch('t2');
      expect(request.request.body).toEqual({ priority: 'urgent' });
      request.flush({ ...normal, priority: 'urgent' });
      await render(fixture);
    });

    it('changing a task sends only what changed, and clears an emptied field', async () => {
      await setup();
      await click(button('Change', cards()[0]));
      await type('task-title', 'Emergency: call Sara back');
      await type('task-details', '');
      await click(button('Save changes'));
      const request = patch('t1');
      expect(request.request.body).toEqual({ title: 'Emergency: call Sara back', details: null });
      request.flush({ ...fromAi, title: 'Emergency: call Sara back', details: null });
      await render(fixture);
      expect(cards()[0]!.textContent).toContain('Emergency: call Sara back');
    });
  });

  it('says why when the queue cannot be loaded', async () => {
    TestBed.configureTestingModule({ imports: [TasksPage], providers: [provideRouter([]), ...httpProviders()] });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: 'staff' }));
    fixture = TestBed.createComponent(TasksPage);
    await render(fixture);
    http.expectOne((r) => r.url === '/api/tasks').flush({ message: 'x' }, { status: 500, statusText: 'x' });
    http.match('/api/members').forEach((request) => request.flush([]));
    await render(fixture);
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('Something went wrong');
  });
});
