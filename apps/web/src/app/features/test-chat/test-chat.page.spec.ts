import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AgentReply } from '@frontdesk/shared';
import { AuthService } from '../../core/auth/auth.service';
import { httpProviders, makeSession, PRACTICE_A, PRACTICE_B, render, signIn } from '../../testing/helpers';
import { TestChatPage } from './test-chat.page';

const GREETING = 'Thank you for calling Alpha Clinic. You are speaking with an automated AI assistant, not a person.';

const reply = (extra: Partial<AgentReply> = {}): AgentReply => ({
  conversationId: 'c1',
  reply: 'We are open Monday to Friday.',
  status: 'active',
  outcome: null,
  escalation: null,
  source: 'model',
  createdTaskIds: [],
  ...extra,
});

describe('TestChatPage', () => {
  let fixture: ComponentFixture<TestChatPage>;
  let http: HttpTestingController;

  async function setup(practices = [{ ...PRACTICE_A, role: 'admin' as const }]) {
    TestBed.configureTestingModule({ imports: [TestChatPage], providers: [...httpProviders(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ practices }));
    fixture = TestBed.createComponent(TestChatPage);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const button = (text: string) => [...root().querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));
  const box = () => root().querySelector<HTMLTextAreaElement>('#message')!;
  const startRequest = () => http.expectOne((r) => r.url === '/api/agent/test-conversations' && r.method === 'POST');
  const messageRequest = (id = 'c1') => http.expectOne((r) => r.url === `/api/agent/test-conversations/${id}/messages` && r.method === 'POST');
  const lines = () => [...root().querySelectorAll('.log .line')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
  const alerts = () => [...root().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());
  const statuses = () => [...root().querySelectorAll('[role="status"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());

  async function startChat() {
    button('Start a test chat')!.click();
    await render(fixture);
    startRequest().flush({ conversationId: 'c1', greeting: GREETING });
    await render(fixture);
  }
  async function typeText(value: string) {
    box().value = value;
    box().dispatchEvent(new Event('input'));
    await render(fixture);
  }
  async function say(value: string, answer: AgentReply) {
    await typeText(value);
    button('Send')!.click();
    await render(fixture);
    messageRequest().flush(answer);
    await render(fixture);
  }

  afterEach(() => http.verify());

  describe('before a chat', () => {
    it('warns that what the AI does is real, and offers to start', async () => {
      await setup();
      expect(root().querySelector('[role="note"]')?.textContent).toContain('what the AI does is real');
      expect(root().querySelector('[role="note"]')?.textContent).toContain('Nothing is sent to a patient');
      expect(button('Start a test chat')).toBeDefined();
      expect(box()).toBeNull();
    });

    it('opens with the greeting, and shows the box for the caller’s reply', async () => {
      await setup();
      await startChat();
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toContain('AI receptionist');
      expect(lines()[0]).toContain(GREETING);
      expect(box()).not.toBeNull();
      expect(button('Send')!.disabled).toBe(true); // nothing typed yet
    });

    it('lists everything still missing when the AI is not set up, and points to the settings', async () => {
      await setup();
      button('Start a test chat')!.click();
      await render(fixture);
      startRequest().flush({ message: ['Write a greeting', 'Write the crisis message callers will hear'] }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(alerts()[0]).toContain('Write a greeting');
      expect(alerts()[0]).toContain('Write the crisis message');
      expect(root().querySelector('a[href="/ai"]')).not.toBeNull();
      expect(button('Start a test chat')).toBeDefined(); // can try again after fixing it
    });

    it('says plainly when no AI model is configured (503), not "the service is not responding"', async () => {
      await setup();
      button('Start a test chat')!.click();
      await render(fixture);
      startRequest().flush(
        { message: 'The AI model is not set up yet. Ask the system administrator to configure it.' },
        { status: 503, statusText: 'Service Unavailable' },
      );
      await render(fixture);
      expect(alerts()[0]).toBe('The AI model is not set up yet. Ask the system administrator to configure it.');
    });

    it('a real outage (a gateway error with no explanation) still says the service is not responding', async () => {
      await setup();
      button('Start a test chat')!.click();
      await render(fixture);
      startRequest().flush('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' });
      await render(fixture);
      expect(alerts()[0]).toBe('The service is not responding right now. Please try again in a moment.');
    });
  });

  describe('talking', () => {
    it('shows the caller’s message, sends it, and shows the reply', async () => {
      await setup();
      await startChat();
      await typeText('  What are your hours?  ');
      button('Send')!.click();
      await render(fixture);

      expect(lines()[1]).toContain('You (as the caller)');
      expect(lines()[1]).toContain('What are your hours?');
      expect(statuses().join(' ')).toContain('replying');
      expect(box().disabled).toBe(true);
      const request = messageRequest();
      expect(request.request.body).toEqual({ text: 'What are your hours?' });
      request.flush(reply());
      await render(fixture);

      expect(lines()).toHaveLength(3);
      expect(lines()[2]).toContain('We are open Monday to Friday.');
      expect(lines()[2]).not.toContain('Fixed');
      expect(box().value).toBe('');
      expect(box().disabled).toBe(false);
    });

    it('sends on Enter, but not on Shift+Enter or while empty', async () => {
      await setup();
      await startChat();
      await typeText('hello');
      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
      await render(fixture);
      http.expectNone((r) => r.url.endsWith('/messages'));

      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
      await render(fixture);
      messageRequest().flush(reply());
      await render(fixture);

      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); // empty now
      await render(fixture);
      http.expectNone((r) => r.url.endsWith('/messages'));
    });

    it('does not send a message of only spaces', async () => {
      await setup();
      await startChat();
      await typeText('    ');
      expect(button('Send')!.disabled).toBe(true);
    });

    it('gives the message back in the box, with the reason, when it could not be answered', async () => {
      await setup();
      await startChat();
      await typeText('Please help');
      button('Send')!.click();
      await render(fixture);
      messageRequest().flush({ message: 'x' }, { status: 500, statusText: 'x' });
      await render(fixture);

      expect(lines()).toHaveLength(1); // only the greeting
      expect(box().value).toBe('Please help');
      expect(alerts()[0]).toBe('Something went wrong. Please try again.');
      expect(button('Send')!.disabled).toBe(false);
    });
  });

  describe('safety behaviour is visible, never hidden', () => {
    it('labels a fixed emergency message as not written by the AI, and says staff were alerted', async () => {
      await setup();
      await startChat();
      await say('I have chest pain', reply({ reply: 'If this is a medical emergency, call 911. I have also alerted our team.', source: 'scripted_emergency', escalation: 'emergency', createdTaskIds: ['t1'] }));

      expect(lines()[2]).toContain('Fixed safety message, not written by the AI');
      expect(statuses().join(' ')).toContain('The safety rules were triggered in this chat (emergency or crisis)');
      expect(root().textContent).toContain('created 1 task for staff');
      expect(box()).not.toBeNull(); // still on the line, to take a callback request
    });

    it('labels an urgent message too', async () => {
      await setup();
      await startChat();
      await say('I ran out of my medication', reply({ source: 'scripted_urgent', escalation: 'urgent', createdTaskIds: ['t1'] }));
      expect(lines()[2]).toContain('Fixed message for an urgent request');
      expect(statuses().join(' ')).toContain('urgent request');
    });

    it('says when the AI’s own reply was replaced by a safe one', async () => {
      await setup();
      await startChat();
      await say('what is wrong with me', reply({ reply: 'I am sorry, I am not able to help with that here.', source: 'scripted_guard' }));
      expect(lines()[2]).toContain('AI’s own reply was not used');
    });

    it('adds up the tasks created over the chat', async () => {
      await setup();
      await startChat();
      await say('one', reply({ createdTaskIds: ['t1'] }));
      await say('two', reply({ createdTaskIds: ['t2', 't3'] }));
      expect(root().textContent).toContain('created 3 tasks for staff');
    });
  });

  describe('when the chat ends', () => {
    it('hands over: the box goes away, the outcome is explained, and a new chat can start', async () => {
      await setup();
      await startChat();
      await say('I want to talk to someone', reply({ reply: 'Connecting you now.', status: 'handed_off', outcome: 'handed_off' }));
      expect(box()).toBeNull();
      expect(statuses().join(' ')).toContain('handed to a person');

      button('Start over')!.click();
      await render(fixture);
      startRequest().flush({ conversationId: 'c2', greeting: GREETING });
      await render(fixture);
      expect(lines()).toHaveLength(1);
      expect(box()).not.toBeNull();
    });

    it('says what happened when the AI finished the chat', async () => {
      await setup();
      await startChat();
      await say('bye', reply({ status: 'completed', outcome: 'message_taken' }));
      expect(statuses().join(' ')).toContain('a message was left for the team');
    });

    it('treats “already ended” from the server as the end of the chat and keeps the message', async () => {
      await setup();
      await startChat();
      await typeText('one more thing');
      button('Send')!.click();
      await render(fixture);
      messageRequest().flush({ message: 'This conversation has ended. Start a new one.' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(alerts()[0]).toBe('This conversation has ended. Start a new one.');
      expect(box()).toBeNull();
      expect(button('Start over')).toBeDefined();
    });

    it('starting over clears the old chat’s notices and count', async () => {
      await setup();
      await startChat();
      await say('chest pain', reply({ source: 'scripted_emergency', escalation: 'emergency', createdTaskIds: ['t1'] }));
      button('Start over')!.click();
      await render(fixture);
      startRequest().flush({ conversationId: 'c2', greeting: GREETING });
      await render(fixture);
      expect(root().textContent).not.toContain('safety rules were triggered');
      expect(root().textContent).not.toContain('created 1 task');
    });
  });

  it('a chat belongs to one practice: switching practice clears it, and a late answer is ignored', async () => {
    const practices = [{ ...PRACTICE_A, role: 'admin' as const }, { ...PRACTICE_B, role: 'admin' as const }];
    await setup(practices);
    await startChat();
    await typeText('hello');
    button('Send')!.click();
    await render(fixture);
    const late = messageRequest(); // slow: not answered yet

    const switching = TestBed.inject(AuthService).switchPractice(PRACTICE_B.id);
    http.expectOne('/api/auth/switch-practice').flush(makeSession({ practices, current: practices[1], token: 'beta' }));
    await switching;
    await render(fixture);
    expect(lines()).toHaveLength(0);
    expect(button('Start a test chat')).toBeDefined();

    late.flush(reply({ reply: 'An answer for the old practice' }));
    await render(fixture);
    expect(root().textContent).not.toContain('An answer for the old practice');
    // The chat is not on screen after the switch, so also look at what the page holds.
    const state = fixture.componentInstance as unknown as { lines(): unknown[]; tasksCreated(): number };
    expect(state.lines()).toHaveLength(0);
  });

  it('will not send once the chat has ended, even if asked directly rather than through the hidden box', async () => {
    await setup();
    await startChat();
    await say('I want to talk to someone', reply({ status: 'handed_off', outcome: 'handed_off' }));
    const page = fixture.componentInstance as unknown as { text: { set(value: string): void }; send(): Promise<void> };
    page.text.set('one more thing');
    await page.send();
    http.expectNone((r) => r.url.endsWith('/messages'));
  });
});
