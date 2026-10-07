import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ConversationDetail, ConversationSummary } from '@frontdesk/shared';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { httpProviders, makeSession, render, signIn } from '../../testing/helpers';
import { ConversationPage } from './conversation.page';
import { ConversationsPage } from './conversations.page';

const summary = (id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id,
  channel: 'test_chat',
  status: 'completed',
  outcome: 'answered',
  escalation: null,
  turnCount: 4,
  startedAt: '2026-10-05T13:00:00.000Z',
  endedAt: '2026-10-05T13:05:00.000Z',
  startedByName: 'Jane Smith',
  model: 'llama3.2:3b',
  ...extra,
});

describe('ConversationsPage', () => {
  let fixture: ComponentFixture<ConversationsPage>;
  let http: HttpTestingController;

  async function setup(items: ConversationSummary[], cursor: string | null = null) {
    TestBed.configureTestingModule({ imports: [ConversationsPage], providers: [provideRouter([]), ...httpProviders()] });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: 'staff' }));
    fixture = TestBed.createComponent(ConversationsPage);
    await render(fixture);
    http.expectOne((r) => r.url === '/api/conversations').flush({ items, nextCursor: cursor });
    await render(fixture);
  }
  const root = () => fixture.nativeElement as HTMLElement;

  afterEach(() => http.verify());

  it('lists conversations newest first with their outcome, and links to each', async () => {
    await setup([summary('c2', { channel: 'phone', escalation: 'emergency', outcome: 'emergency', startedByName: null }), summary('c1')]);
    const rows = [...root().querySelectorAll<HTMLAnchorElement>('a.row')];
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/conversations/c2', '/conversations/c1']);
    expect(rows[0]!.textContent).toContain('Phone call');
    expect(rows[0]!.textContent).toContain('Emergency');
    expect(rows[0]!.classList).toContain('emergency');
    expect(rows[1]!.textContent).toContain('Test chat');
    expect(rows[1]!.textContent).toContain('by Jane Smith');
    expect(rows[1]!.textContent).toContain('Answered');
    expect(rows[1]!.textContent).toContain('5 Oct 2026, 09:00');
  });

  it('loads more with the page position the server gave', async () => {
    await setup([summary('c1')], 'next');
    [...root().querySelectorAll('button')].find((b) => b.textContent?.includes('Load more'))!.click();
    await render(fixture);
    const request = http.expectOne((r) => r.url === '/api/conversations');
    expect(request.request.params.get('cursor')).toBe('next');
    request.flush({ items: [summary('c0')], nextCursor: null });
    await render(fixture);
    expect(root().querySelectorAll('a.row')).toHaveLength(2);
  });

  it('says when there are none yet', async () => {
    await setup([]);
    expect(root().textContent).toContain('No conversations yet');
  });
});

describe('ConversationPage (one transcript)', () => {
  let fixture: ComponentFixture<ConversationPage>;
  let http: HttpTestingController;
  const params = new BehaviorSubject(convertToParamMap({ id: 'c1' }));

  const detail: ConversationDetail = {
    ...summary('c1', { escalation: 'emergency', outcome: 'emergency', status: 'completed' }),
    handoffTo: { label: 'On-call nurse' },
    turns: [
      { seq: 1, speaker: 'ai', source: 'greeting', text: 'Thank you for calling.', guardReason: null, blockedText: null, latencyMs: null, at: '2026-10-05T13:00:00.000Z' },
      { seq: 2, speaker: 'caller', source: 'caller', text: 'Book me a visit', guardReason: null, blockedText: null, latencyMs: null, at: '2026-10-05T13:00:10.000Z' },
      { seq: 3, speaker: 'ai', source: 'scripted_booking', text: 'Your Visit with Dr Khan is booked for Tuesday 6 October at 9:00 AM.', guardReason: null, blockedText: null, latencyMs: 900, at: '2026-10-05T13:00:12.000Z' },
      { seq: 4, speaker: 'caller', source: 'caller', text: 'Should I double my pills?', guardReason: null, blockedText: null, latencyMs: null, at: '2026-10-05T13:01:00.000Z' },
      { seq: 5, speaker: 'ai', source: 'scripted_guard', text: 'I am sorry, I am not able to help with that here.', guardReason: 'medication_advice', blockedText: 'Take two tablets.', latencyMs: 800, at: '2026-10-05T13:01:02.000Z' },
    ],
    toolCalls: [
      { turnSeq: 2, tool: 'find_available_slots', arguments: { appointmentType: 'Visit' }, result: { slots: [] }, status: 'ok', durationMs: 20, at: '2026-10-05T13:00:11.000Z' },
      { turnSeq: 2, tool: 'book_appointment', arguments: { slotCode: 'S1' }, result: { error: 'x' }, status: 'rejected', durationMs: 10, at: '2026-10-05T13:00:11.500Z' },
    ],
  };

  async function setup(answer: ConversationDetail | { status: number }) {
    TestBed.configureTestingModule({
      imports: [ConversationPage],
      providers: [provideRouter([]), ...httpProviders(), { provide: ActivatedRoute, useValue: { paramMap: params } }],
    });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ role: 'staff' }));
    fixture = TestBed.createComponent(ConversationPage);
    await render(fixture);
    const request = http.expectOne('/api/conversations/c1');
    if ('turns' in answer) request.flush(answer);
    else request.flush({ message: 'Conversation not found' }, { status: answer.status, statusText: 'x' });
    await render(fixture);
  }
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent!.replace(/\s+/g, ' ');

  afterEach(() => http.verify());

  it('shows every line, saying which ones the AI did not write', async () => {
    await setup(detail);
    const turns = [...root().querySelectorAll<HTMLElement>('li.turn')];
    expect(turns.map((t) => t.querySelector('.who')!.textContent)).toEqual(['AI receptionist', 'Caller', 'AI receptionist', 'Caller', 'AI receptionist']);
    expect(turns[2]!.textContent).toContain('Written by the system from the saved appointment, not by the AI.');
    expect(turns[4]!.textContent).toContain('Replaced because it gave medication advice.');
    expect(turns[1]!.querySelector('.note')).toBeNull(); // the caller's own words carry no note
  });

  it('shows what the AI had written before the safety check replaced it, folded away', async () => {
    await setup(detail);
    const blocked = root().querySelector<HTMLDetailsElement>('details.blocked')!;
    expect(blocked.querySelector('summary')!.textContent).toContain('never shown to the caller');
    expect(blocked.textContent).toContain('Take two tablets.');
    expect(blocked.open).toBe(false);
  });

  it('shows the tools the AI used, in plain words, before the reply they led to', async () => {
    await setup(detail);
    const items = [...root().querySelectorAll('li.tools summary')].map((s) => s.textContent!.trim());
    expect(items).toEqual(['Searched open appointment times: done', 'Booked an appointment: refused by the system']);
    const order = [...root().querySelectorAll('ol.transcript > li')].map((li) => (li.classList.contains('tools') ? 'tools' : li.querySelector('.who')!.textContent));
    expect(order).toEqual(['AI receptionist', 'Caller', 'tools', 'AI receptionist', 'Caller', 'AI receptionist']);
  });

  it('says it was an emergency, who it was handed to, and that opening it was recorded', async () => {
    await setup(detail);
    expect(text()).toContain('involved an emergency');
    expect(text()).toContain('handed to On-call nurse');
    expect(text()).toContain('recorded in the activity log');
  });

  it('says so when the conversation cannot be opened (another practice’s, or gone)', async () => {
    await setup({ status: 404 });
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('Conversation not found');
  });
});
