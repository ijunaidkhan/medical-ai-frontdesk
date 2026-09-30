import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { KnowledgeSearchResult, KnowledgeSourceDetail, KnowledgeSourceSummary, Role } from '@frontdesk/shared';
import { AuthService } from '../../core/auth/auth.service';
import { httpProviders, makeSession, PRACTICE_A, PRACTICE_B, render, signIn } from '../../testing/helpers';
import { KnowledgePage } from './knowledge.page';

const summary = (id: string, title: string, extra: Partial<KnowledgeSourceSummary> = {}): KnowledgeSourceSummary => ({
  id,
  title,
  category: 'general',
  status: 'draft',
  version: 1,
  excerpt: `${title} excerpt`,
  updatedAt: '2026-09-30T14:05:00.000Z',
  approvedAt: null,
  approvedByName: null,
  ...extra,
});

const detail = (id: string, title: string, extra: Partial<KnowledgeSourceDetail> = {}): KnowledgeSourceDetail => ({
  ...summary(id, title),
  content: `${title} content`,
  ...extra,
});

describe('KnowledgePage', () => {
  let fixture: ComponentFixture<KnowledgePage>;
  let http: HttpTestingController;

  async function setup(options: { role?: Role; list?: KnowledgeSourceSummary[] } = {}) {
    TestBed.configureTestingModule({ imports: [KnowledgePage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: options.role ?? 'admin' }));
    fixture = TestBed.createComponent(KnowledgePage);
    await render(fixture);
    listRequest().flush(options.list ?? []);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const field = <T extends HTMLElement>(id: string) => root().querySelector<T>(`#${id}`)!;
  const button = (text: string) => [...root().querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));
  const listRequest = () => http.expectOne((r) => r.url === '/api/knowledge' && r.method === 'GET');
  const detailRequest = (id: string) => http.expectOne((r) => r.url === `/api/knowledge/${id}` && r.method === 'GET');
  const type = async (id: string, value: string) => {
    const element = field<HTMLInputElement | HTMLTextAreaElement>(id);
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await render(fixture);
  };
  const click = async (text: string) => {
    button(text)!.click();
    await render(fixture);
  };
  const open = async (id: string, entry: KnowledgeSourceDetail) => {
    root().querySelector<HTMLButtonElement>(`tr button.link-button`)!; // the list is shown
    const link = [...root().querySelectorAll<HTMLButtonElement>('tr button.link-button')].find((b) => b.textContent?.trim() === entry.title)!;
    link.click();
    await render(fixture);
    detailRequest(id).flush(entry);
    await render(fixture);
  };
  const alerts = () => [...root().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());
  const statuses = () => [...root().querySelectorAll('[role="status"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());
  const rows = () => [...root().querySelectorAll('tbody tr')].map((tr) => tr.textContent?.replace(/\s+/g, ' ').trim());

  afterEach(() => http.verify());

  describe('the list', () => {
    it('shows each entry with its category, a short excerpt, and its status in plain words', async () => {
      await setup({
        list: [
          summary('a', 'Opening hours', { category: 'hours_location', status: 'approved', excerpt: 'Open Monday to Friday' }),
          summary('b', 'Parking', { status: 'draft' }),
        ],
      });
      expect(rows()[0]).toContain('Opening hours');
      expect(rows()[0]).toContain('Hours and location');
      expect(rows()[0]).toContain('Open Monday to Friday');
      expect(rows()[0]).toContain('Approved');
      expect(rows()[1]).toContain('Draft (not used yet)');
    });

    it('keeps archived entries out of the way, behind a toggle that says how many there are', async () => {
      await setup({ list: [summary('a', 'Hours', { status: 'approved' }), summary('b', 'Old policy', { status: 'archived' })] });
      expect(rows()).toHaveLength(1);
      expect(button('Show archived (1)')).toBeDefined();
      await click('Show archived');
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toContain('Old policy');
      expect(root().textContent).toContain('Archived entries');
      await click('Show current entries');
      expect(rows()[0]).toContain('Hours');
    });

    it('invites a manager to add the first entry, and tells a reader there is nothing yet', async () => {
      await setup();
      expect(root().textContent).toContain('Add the first entry');
      TestBed.resetTestingModule();
      await setup({ role: 'staff' });
      expect(root().textContent).toContain('Nothing has been added yet.');
      expect(button('New entry')).toBeUndefined();
    });

    it('shows an error when the list cannot be loaded', async () => {
      TestBed.configureTestingModule({ imports: [KnowledgePage], providers: httpProviders() });
      http = TestBed.inject(HttpTestingController);
      await signIn(makeSession({ role: 'admin' }));
      fixture = TestBed.createComponent(KnowledgePage);
      await render(fixture);
      listRequest().flush({ message: 'x' }, { status: 500, statusText: 'x' });
      await render(fixture);
      expect(alerts()[0]).toBe('Something went wrong. Please try again.');
      expect(root().querySelector('table')).toBeNull();
    });
  });

  describe('adding an entry', () => {
    it('saves a new entry as a draft, trimmed, then shows it in the list', async () => {
      await setup();
      await click('New entry');
      expect(button('Save as draft')!.disabled).toBe(true);

      await type('title', '  Opening hours ');
      await type('content', '  Open Monday to Friday, 9 to 5.  ');
      const select = field<HTMLSelectElement>('category');
      select.value = 'hours_location';
      select.dispatchEvent(new Event('change'));
      await render(fixture);
      await click('Save as draft');

      const post = http.expectOne((r) => r.url === '/api/knowledge' && r.method === 'POST');
      expect(post.request.body).toEqual({ title: 'Opening hours', category: 'hours_location', content: 'Open Monday to Friday, 9 to 5.' });
      post.flush(detail('n1', 'Opening hours', { category: 'hours_location', content: 'Open Monday to Friday, 9 to 5.' }));
      await render(fixture);
      listRequest().flush([summary('n1', 'Opening hours', { category: 'hours_location' })]);
      await render(fixture);

      expect(statuses().join(' ')).toContain('Saved.');
      expect(rows()[0]).toContain('Opening hours');
      expect(root().textContent).toContain('Version 1');
      expect(button('Approve')).toBeDefined(); // now a draft that can be approved
    });

    it('needs both a title and some wording', async () => {
      await setup();
      await click('New entry');
      await type('title', 'Only a title');
      expect(button('Save as draft')!.disabled).toBe(true);
      await type('content', 'And wording');
      expect(button('Save as draft')!.disabled).toBe(false);
    });

    it('shows the reason when the API refuses', async () => {
      await setup();
      await click('New entry');
      await type('title', 'T');
      await type('content', 'C');
      await click('Save as draft');
      http.expectOne((r) => r.url === '/api/knowledge' && r.method === 'POST').flush({ message: 'content must be shorter' }, { status: 400, statusText: 'Bad Request' });
      await render(fixture);
      expect(alerts()[0]).toBe('content must be shorter');
      expect(field<HTMLInputElement>('title').value).toBe('T'); // what was typed is kept
    });
  });

  describe('editing an entry', () => {
    it('opens the entry in the editor with who approved it and the version', async () => {
      const entry = detail('a', 'Hours', { status: 'approved', version: 3, approvedByName: 'Jane Smith', approvedAt: '2026-09-30T14:05:00.000Z' });
      await setup({ list: [summary('a', 'Hours', { status: 'approved' })] });
      await open('a', entry);
      expect(field<HTMLInputElement>('title').value).toBe('Hours');
      expect(field<HTMLTextAreaElement>('content').value).toBe('Hours content');
      expect(root().textContent).toContain('Approved by Jane Smith');
      expect(root().textContent).toContain('Version 3');
    });

    it('sends only what changed', async () => {
      await setup({ list: [summary('a', 'Hours')] });
      await open('a', detail('a', 'Hours'));
      expect(button('Save changes')!.disabled).toBe(true);
      await type('content', 'New wording');
      await click('Save changes');
      const patch = http.expectOne((r) => r.url === '/api/knowledge/a' && r.method === 'PATCH');
      expect(patch.request.body).toEqual({ content: 'New wording' });
      patch.flush(detail('a', 'Hours', { content: 'New wording', version: 2 }));
      await render(fixture);
      listRequest().flush([summary('a', 'Hours', { version: 2 })]);
      await render(fixture);
      expect(root().textContent).toContain('Version 2');
      expect(button('Save changes')!.disabled).toBe(true);
    });

    it('warns that changing approved wording sends it back to draft, and says so after saving', async () => {
      await setup({ list: [summary('a', 'Hours', { status: 'approved' })] });
      await open('a', detail('a', 'Hours', { status: 'approved', approvedByName: 'Jane Smith', approvedAt: '2026-09-30T14:05:00.000Z' }));
      expect(root().textContent).not.toContain('sends it back to draft');

      await type('content', 'Changed hours');
      expect(statuses().join(' ')).toContain('sends it back to draft');
      await click('Save changes');
      http.expectOne((r) => r.url === '/api/knowledge/a' && r.method === 'PATCH').flush(detail('a', 'Hours', { content: 'Changed hours', status: 'draft', version: 2 }));
      await render(fixture);
      listRequest().flush([summary('a', 'Hours', { status: 'draft', version: 2 })]);
      await render(fixture);

      expect(statuses().join(' ')).toContain('draft again and must be approved');
      expect(root().querySelector('.status-line .badge')?.textContent).toContain('Draft');
    });

    it('does not warn when only the category changes (that keeps the approval)', async () => {
      await setup({ list: [summary('a', 'Hours', { status: 'approved' })] });
      await open('a', detail('a', 'Hours', { status: 'approved' }));
      const select = field<HTMLSelectElement>('category');
      select.value = 'policies';
      select.dispatchEvent(new Event('change'));
      await render(fixture);
      expect(root().textContent).not.toContain('sends it back to draft');
      expect(button('Save changes')!.disabled).toBe(false);
    });

    it('never throws away unsaved wording: opening another entry is refused until it is saved or discarded', async () => {
      await setup({ list: [summary('a', 'Hours'), summary('b', 'Parking')] });
      await open('a', detail('a', 'Hours'));
      await type('content', 'Half-written');

      const other = [...root().querySelectorAll<HTMLButtonElement>('tr button.link-button')].find((b) => b.textContent?.trim() === 'Parking')!;
      other.click();
      await render(fixture);
      http.expectNone('/api/knowledge/b');
      expect(alerts()[0]).toContain('unsaved changes');
      expect(field<HTMLTextAreaElement>('content').value).toBe('Half-written');

      await click('Discard changes');
      expect(field<HTMLTextAreaElement>('content').value).toBe('Hours content');
      expect(button('Discard changes')).toBeUndefined();
    });
  });

  describe('approving, archiving and restoring', () => {
    it('offers Approve only on a draft, and only when nothing is unsaved', async () => {
      await setup({ list: [summary('a', 'Hours')] });
      await open('a', detail('a', 'Hours'));
      expect(button('Approve')!.disabled).toBe(false);
      await type('content', 'edited');
      expect(button('Approve')!.disabled).toBe(true);
      expect(button('Archive')!.disabled).toBe(true);
      expect(root().textContent).toContain('Save or discard your changes before approving or archiving.');
    });

    it('approves a draft and says the AI can now use it', async () => {
      await setup({ list: [summary('a', 'Hours')] });
      await open('a', detail('a', 'Hours'));
      await click('Approve');
      http.expectOne((r) => r.url === '/api/knowledge/a/approve' && r.method === 'POST').flush(detail('a', 'Hours', { status: 'approved', approvedByName: 'Jane Smith', approvedAt: '2026-09-30T14:10:00.000Z' }));
      await render(fixture);
      listRequest().flush([summary('a', 'Hours', { status: 'approved' })]);
      await render(fixture);

      expect(statuses().join(' ')).toContain('The AI receptionist can now use this');
      expect(button('Approve')).toBeUndefined();
      expect(root().textContent).toContain('Approved by Jane Smith');
    });

    it('does not offer Approve for an entry that is already approved', async () => {
      await setup({ list: [summary('a', 'Hours', { status: 'approved' })] });
      await open('a', detail('a', 'Hours', { status: 'approved' }));
      expect(button('Approve')).toBeUndefined();
      expect(button('Archive')).toBeDefined();
    });

    it('archives an entry, which makes it read-only and offers Restore', async () => {
      await setup({ list: [summary('a', 'Hours', { status: 'approved' })] });
      await open('a', detail('a', 'Hours', { status: 'approved' }));
      await click('Archive');
      http.expectOne((r) => r.url === '/api/knowledge/a/archive' && r.method === 'POST').flush(detail('a', 'Hours', { status: 'archived' }));
      await render(fixture);
      listRequest().flush([summary('a', 'Hours', { status: 'archived' })]);
      await render(fixture);

      expect(statuses().join(' ')).toContain('no longer uses this');
      expect(field<HTMLInputElement>('title').disabled).toBe(true);
      expect(field<HTMLTextAreaElement>('content').disabled).toBe(true);
      expect(button('Save changes')).toBeUndefined();
      expect(button('Archive')).toBeUndefined();
      expect(button('Restore')).toBeDefined();
      expect(rows()).toHaveLength(0); // moved behind the archived toggle
    });

    it('restores an archived entry as a draft', async () => {
      await setup({ list: [summary('a', 'Old policy', { status: 'archived' })] });
      await click('Show archived');
      await open('a', detail('a', 'Old policy', { status: 'archived' }));
      await click('Restore');
      http.expectOne((r) => r.url === '/api/knowledge/a/restore' && r.method === 'POST').flush(detail('a', 'Old policy', { status: 'draft' }));
      await render(fixture);
      listRequest().flush([summary('a', 'Old policy', { status: 'draft' })]);
      await render(fixture);
      expect(statuses().join(' ')).toContain('Restored as a draft');
      expect(field<HTMLInputElement>('title').disabled).toBe(false);
    });

    it('shows the API’s reason when a change is refused', async () => {
      await setup({ list: [summary('a', 'Hours')] });
      await open('a', detail('a', 'Hours'));
      await click('Approve');
      http.expectOne((r) => r.url === '/api/knowledge/a/approve').flush({ message: 'Already approved' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(alerts()[0]).toBe('Already approved');
    });
  });

  describe('the actions refuse on their own, not only through disabled buttons', () => {
    type Actions = { approve(): Promise<void>; archive(): Promise<void>; save(): Promise<void>; setField(field: string, value: string): void };
    const actions = () => fixture.componentInstance as unknown as Actions;

    it('will not approve or archive while there are unsaved changes', async () => {
      await setup({ list: [summary('a', 'Hours')] });
      await open('a', detail('a', 'Hours'));
      await type('content', 'edited');
      await actions().approve();
      await actions().archive();
      http.expectNone((r) => r.url.endsWith('/approve') || r.url.endsWith('/archive'));
    });

    it('will not save for someone who may only read, even if the wording is changed in code', async () => {
      await setup({ role: 'staff', list: [summary('a', 'Hours')] });
      await open('a', detail('a', 'Hours'));
      actions().setField('content', 'sneaky edit');
      await actions().save();
      http.expectNone((r) => r.method === 'PATCH' || r.method === 'POST');
    });
  });

  describe('someone who may only read (staff)', () => {
    it('can read an entry but has nothing to change it with', async () => {
      await setup({ role: 'staff', list: [summary('a', 'Hours', { status: 'approved' })] });
      await open('a', detail('a', 'Hours', { status: 'approved' }));
      expect(field<HTMLInputElement>('title').disabled).toBe(true);
      expect(field<HTMLTextAreaElement>('content').disabled).toBe(true);
      for (const label of ['New entry', 'Save changes', 'Approve', 'Archive', 'Restore']) {
        expect(button(label)).toBeUndefined();
      }
      expect(root().textContent).toContain('only an owner or administrator can change them');
    });

    it('can still search', async () => {
      await setup({ role: 'staff' });
      expect(field('question')).not.toBeNull();
    });
  });

  describe('what would the AI find?', () => {
    const found = (title: string, text: string): KnowledgeSearchResult => ({ chunkId: title, sourceId: 's', title, text, rank: 1 });

    it('shows the approved information a question would bring up', async () => {
      await setup();
      await type('question', '  Do you take insurance? ');
      await click('Search');
      const request = http.expectOne((r) => r.url === '/api/knowledge/search');
      expect(request.request.params.get('q')).toBe('Do you take insurance?');
      request.flush([found('Insurance', 'We accept Blue Cross and Aetna.')]);
      await render(fixture);
      expect(root().querySelector('.results')?.textContent).toContain('We accept Blue Cross and Aetna.');
    });

    it('says plainly when nothing approved matches', async () => {
      await setup();
      await type('question', 'parking');
      await click('Search');
      http.expectOne((r) => r.url === '/api/knowledge/search').flush([]);
      await render(fixture);
      expect(statuses().join(' ')).toContain('does not have that information');
    });

    it('will not search for an empty question, and shows a failure', async () => {
      await setup();
      expect(button('Search')!.disabled).toBe(true);
      await type('question', 'hours');
      await click('Search');
      http.expectOne((r) => r.url === '/api/knowledge/search').flush({ message: 'x' }, { status: 500, statusText: 'x' });
      await render(fixture);
      expect(alerts()[0]).toBe('Something went wrong. Please try again.');
    });
  });

  it('starts again for the new practice after a switch, and ignores a late answer for the old one', async () => {
    const practices = [{ ...PRACTICE_A, role: 'admin' as const }, { ...PRACTICE_B, role: 'admin' as const }];
    TestBed.configureTestingModule({ imports: [KnowledgePage], providers: httpProviders() });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ practices }));
    fixture = TestBed.createComponent(KnowledgePage);
    await render(fixture);
    const oldList = listRequest(); // slow: not answered yet

    const switching = TestBed.inject(AuthService).switchPractice(PRACTICE_B.id);
    http.expectOne('/api/auth/switch-practice').flush(makeSession({ practices, current: practices[1], token: 'beta' }));
    await switching;
    await render(fixture);

    listRequest().flush([summary('b1', 'Beta hours')]);
    await render(fixture);
    oldList.flush([summary('a1', 'Alpha hours')]);
    await render(fixture);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Beta hours');
    expect(root().textContent).not.toContain('Alpha hours');
  });
});
