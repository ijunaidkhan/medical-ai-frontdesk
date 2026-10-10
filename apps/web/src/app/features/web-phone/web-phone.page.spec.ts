import { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PracticeSummary, StartWebCallResponse } from '@frontdesk/shared';
import { AuthService } from '../../core/auth/auth.service';
import { SpeechService, type ListenHandlers, type Listening } from '../../core/speech.service';
import { OPEN_VOICE_SOCKET, type OpenVoiceSocket, type VoiceSocketHandlers } from '../../core/voice-socket';
import { httpProviders, makeSession, PRACTICE_A, PRACTICE_B, render, signIn } from '../../testing/helpers';
import { WebPhonePage } from './web-phone.page';

const GREETING = 'Thank you for calling Alpha Clinic. You are speaking with an automated AI assistant, not a person.';
const CALL: StartWebCallResponse = { conversationId: 'c1', greeting: GREETING, callSid: 'WEBabc', sessionPath: '/api/voice/relay?token=t1' };

/** The browser's speech tools, replaced: tests decide what is heard and when speaking ends. */
class FakeSpeech {
  canRun = true;
  /** While true, speaking never ends by itself: the test calls finishSpeaking(). */
  held = false;
  spoken: string[] = [];
  cancelled = 0;
  listens = 0;
  stops = 0;
  listening: ListenHandlers | null = null;
  private pending: Array<() => void> = [];

  supported = () => this.canRun;

  listen = (handlers: ListenHandlers): Listening => {
    this.listens += 1;
    this.listening = handlers;
    return {
      stop: () => {
        this.stops += 1;
        if (this.listening === handlers) this.listening = null;
      },
    };
  };

  speak = (text: string): Promise<void> => {
    this.spoken.push(text);
    return this.held ? new Promise<void>((resolve) => this.pending.push(resolve)) : Promise.resolve();
  };

  cancelSpeech = (): void => {
    this.cancelled += 1;
    this.finishSpeaking();
  };

  finishSpeaking(): void {
    this.pending.splice(0).forEach((resolve) => resolve());
  }

  /** The caller finishes a sentence (listening stops by itself, as in the real service). */
  hear(text: string): void {
    const handlers = this.listening!;
    this.listening = null;
    handlers.onSentence(text);
  }
}

interface FakeSocket {
  path: string;
  handlers: VoiceSocketHandlers;
  sent: Array<Record<string, unknown>>;
  closed: boolean;
}

describe('WebPhonePage', () => {
  let fixture: ComponentFixture<WebPhonePage>;
  let http: HttpTestingController;
  let speech: FakeSpeech;
  let sockets: FakeSocket[];

  async function setup(options: { supported?: boolean; practices?: PracticeSummary[] } = {}) {
    speech = new FakeSpeech();
    speech.canRun = options.supported ?? true;
    sockets = [];
    const openSocket: OpenVoiceSocket = (path, handlers) => {
      const socket: FakeSocket = { path, handlers, sent: [], closed: false };
      sockets.push(socket);
      return {
        send: (data) => socket.sent.push(JSON.parse(data) as Record<string, unknown>),
        close: () => {
          socket.closed = true;
        },
      };
    };
    TestBed.configureTestingModule({
      imports: [WebPhonePage],
      providers: [...httpProviders(), provideRouter([]), { provide: SpeechService, useValue: speech }, { provide: OPEN_VOICE_SOCKET, useValue: openSocket }],
    });
    http = TestBed.inject(HttpTestingController);
    await signIn(makeSession({ practices: options.practices ?? [{ ...PRACTICE_A, role: 'admin' as const }] }));
    fixture = TestBed.createComponent(WebPhonePage);
    await render(fixture);
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const button = (text: string) => [...root().querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  const lines = () => [...root().querySelectorAll('.log .line')].map((li) => [...li.querySelectorAll('.who, .said, .note')].map((part) => part.textContent?.trim()).join(' '));
  const moment = () => root().querySelector('.moment')?.textContent?.trim();
  const alerts = () => [...root().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());
  const ended = () => root().querySelector('p.alert[role="status"]')?.textContent?.trim();
  const startRequest = () => http.expectOne((r) => r.url === '/api/voice/web-calls' && r.method === 'POST');

  async function clickStart() {
    button('Start a call')!.click();
    await render(fixture);
  }

  /** Starts a call and opens its session, as the browser would. */
  async function startCall(): Promise<FakeSocket> {
    await clickStart();
    startRequest().flush(CALL);
    await render(fixture);
    const socket = sockets.at(-1)!;
    socket.handlers.onOpen();
    await render(fixture);
    return socket;
  }

  async function fromServer(socket: FakeSocket, message: Record<string, unknown>) {
    socket.handlers.onMessage(JSON.stringify(message));
    await render(fixture);
  }
  const text = (token: string, interruptible = true) => ({ type: 'text', token, last: true, interruptible });
  const end = (reason: string) => ({ type: 'end', handoffData: JSON.stringify({ reason }) });

  afterEach(() => http.verify());

  describe('before a call', () => {
    it('warns that what the AI does is real and that the voice goes to a speech service, and offers to start', async () => {
      await setup();
      const note = root().querySelector('[role="note"]')?.textContent ?? '';
      expect(note).toContain('what the AI does is real');
      expect(note).toContain('Google or Microsoft');
      expect(button('Start a call')).toBeDefined();
    });

    it('says so, and offers nothing, when the browser cannot listen and speak', async () => {
      await setup({ supported: false });
      expect(root().textContent).toContain('Use Chrome or Edge');
      expect(button('Start a call')).toBeUndefined();
    });

    it('lists everything still missing when the AI is not set up, and points to the settings', async () => {
      await setup();
      await clickStart();
      startRequest().flush({ message: ['Write a greeting', 'Write the crisis message callers will hear'] }, { status: 409, statusText: 'Conflict' });
      await render(fixture);
      expect(alerts()[0]).toContain('Write a greeting');
      expect(alerts()[0]).toContain('Write the crisis message');
      expect(root().querySelector('a[href="/ai"]')).not.toBeNull();
      expect(button('Start a call')).toBeDefined(); // can try again after fixing it
      expect(sockets).toHaveLength(0);
    });

    it('a second click while the call is being set up does not start a second call', async () => {
      await setup();
      const page = fixture.componentInstance as unknown as { start(): Promise<void> };
      const first = page.start();
      const second = page.start();
      await render(fixture);
      startRequest().flush(CALL); // expectOne: exactly one request was made
      await Promise.all([first, second]);
      await render(fixture);
      expect(sockets).toHaveLength(1);
    });

    it('says plainly that the web phone is switched off on this server (404)', async () => {
      await setup();
      await clickStart();
      startRequest().flush({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });
      await render(fixture);
      expect(alerts()[0]).toContain('switched off on this server');
      expect(alerts()[0]).toContain('VOICE_PROVIDER=dev');
    });

    it('says plainly when no AI model is configured (503)', async () => {
      await setup();
      await clickStart();
      startRequest().flush({ message: 'The AI model is not set up yet. Ask the system administrator to configure it.' }, { status: 503, statusText: 'Service Unavailable' });
      await render(fixture);
      expect(alerts()[0]).toBe('The AI model is not set up yet. Ask the system administrator to configure it.');
    });
  });

  describe('on a call', () => {
    it('opens the session at the address given, announces the call, and speaks the greeting before listening', async () => {
      await setup();
      speech.held = true;
      const socket = await startCall();
      expect(socket.path).toBe('/api/voice/relay?token=t1');
      expect(socket.sent).toEqual([{ type: 'setup', callSid: 'WEBabc' }]);
      expect(lines()).toEqual([`AI receptionist ${GREETING}`]);
      expect(speech.spoken).toEqual([GREETING]);
      expect(moment()).toBe('The receptionist is speaking…');
      expect(speech.listens).toBe(0); // the microphone is off while the receptionist talks

      speech.finishSpeaking();
      await render(fixture);
      expect(speech.listens).toBe(1);
      expect(moment()).toBe('Listening…');
    });

    it('sends what the caller says as a finished sentence, and keeps the microphone off until the reply has been spoken', async () => {
      await setup();
      const socket = await startCall();
      speech.hear('I need an appointment next week');
      await render(fixture);

      expect(socket.sent.at(-1)).toEqual({ type: 'prompt', voicePrompt: 'I need an appointment next week', lang: 'en-US', last: true });
      expect(lines().at(-1)).toBe('You (as the caller) I need an appointment next week');
      expect(moment()).toBe('The receptionist is thinking…');
      expect(speech.listening).toBeNull();

      speech.held = true;
      await fromServer(socket, text('Of course. May I have your full name?'));
      expect(lines().at(-1)).toBe('AI receptionist Of course. May I have your full name?');
      expect(speech.spoken.at(-1)).toBe('Of course. May I have your full name?');
      expect(speech.listening).toBeNull(); // still speaking
      speech.finishSpeaking();
      await render(fixture);
      expect(speech.listening).not.toBeNull();
      expect(moment()).toBe('Listening…');
    });

    it('shows the words being recognised as they come, then the finished sentence in their place', async () => {
      await setup();
      await startCall();
      speech.listening!.onHearing('I need an app');
      await render(fixture);
      expect(root().querySelector('.hearing')?.textContent).toContain('I need an app');
      speech.hear('I need an appointment');
      await render(fixture);
      expect(root().querySelector('.hearing')).toBeNull();
      expect(lines().filter((line) => line?.includes('I need an appointment'))).toHaveLength(1);
    });

    it('marks a fixed safety message, which cannot be talked over on a real call', async () => {
      await setup();
      const socket = await startCall();
      await fromServer(socket, text('If this is a medical emergency, hang up and call 911 now.', false));
      expect(lines().at(-1)).toContain('Fixed safety message, not written by the AI');
      await fromServer(socket, text('We are open every day.'));
      expect(lines().at(-1)).not.toContain('Fixed safety message');
    });

    it('Interrupt cuts the receptionist off and goes back to listening, and is offered only while it speaks', async () => {
      await setup();
      speech.held = true;
      await startCall();
      expect(button('Interrupt')!.disabled).toBe(false);
      button('Interrupt')!.click();
      await render(fixture);
      expect(speech.cancelled).toBeGreaterThan(0);
      expect(moment()).toBe('Listening…');
      expect(button('Interrupt')!.disabled).toBe(true);
    });

    it('counts the length of the call', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // the test helpers still need the real setTimeout
      try {
        await setup();
        await startCall();
        expect(root().querySelector('.clock')?.textContent).toBe('00:00');
        await vi.advanceTimersByTimeAsync(65_000);
        fixture.detectChanges();
        expect(root().querySelector('.clock')?.textContent).toBe('01:05');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('ending a call', () => {
    it('when the receptionist ends it, the goodbye is heard first, then the call ends and says why', async () => {
      await setup();
      const socket = await startCall();
      speech.held = true;
      await fromServer(socket, text('Goodbye, take care.'));
      await fromServer(socket, end('completed'));
      expect(ended()).toBeUndefined(); // still saying goodbye
      expect(socket.closed).toBe(false);

      const listensBefore = speech.listens;
      speech.finishSpeaking();
      await render(fixture);
      expect(ended()).toContain('the receptionist finished the conversation');
      expect(socket.closed).toBe(true);
      expect(speech.listens).toBe(listensBefore); // no listening after the goodbye
      expect(root().querySelector('a[href="/conversations/c1"]')).not.toBeNull();
    });

    it('explains a hand-over to a person', async () => {
      await setup();
      const socket = await startCall();
      await fromServer(socket, text('I will pass you to our team.'));
      await fromServer(socket, end('handed_off'));
      expect(ended()).toContain('handed to a person');
    });

    it('Hang up ends the call at once: the session is closed, the microphone off, and the speech cut', async () => {
      await setup();
      speech.held = true;
      const socket = await startCall();
      button('Hang up')!.click();
      await render(fixture);
      expect(socket.closed).toBe(true);
      expect(speech.cancelled).toBeGreaterThan(0);
      expect(ended()).toBe('You hung up.');
      expect(button('Hang up')).toBeUndefined();
      expect(root().querySelector('a[href="/conversations/c1"]')).not.toBeNull();
    });

    it('if the server closes the session, the call ends and says so', async () => {
      await setup();
      const socket = await startCall();
      socket.handlers.onClose();
      await render(fixture);
      expect(ended()).toBe('The call was closed by the server.');
      expect(speech.listening).toBeNull();
    });

    it('if the session never opens, says so and does not offer a conversation to open', async () => {
      await setup();
      await clickStart();
      startRequest().flush(CALL);
      await render(fixture);
      sockets[0]!.handlers.onClose();
      await render(fixture);
      expect(ended()).toContain('could not be opened');
      expect(root().querySelector('a[href="/conversations/c1"]')).toBeNull();
    });

    it('when the microphone cannot be used, the call ends and says why', async () => {
      await setup();
      const socket = await startCall();
      speech.listening!.onProblem('The microphone is blocked. Allow it for this site, then start the call again.');
      await render(fixture);
      expect(alerts()[0]).toContain('The microphone is blocked');
      expect(ended()).toContain('microphone could not be used');
      expect(socket.closed).toBe(true);
    });

    it('ignores anything a finished call still sends', async () => {
      await setup();
      const socket = await startCall();
      button('Hang up')!.click();
      await render(fixture);
      const spoken = speech.spoken.length;
      await fromServer(socket, text('A late answer'));
      socket.handlers.onClose();
      await render(fixture);
      expect(root().textContent).not.toContain('A late answer');
      expect(speech.spoken).toHaveLength(spoken);
      expect(ended()).toBe('You hung up.');
    });

    it('another call starts clean', async () => {
      await setup();
      await startCall();
      button('Hang up')!.click();
      await render(fixture);
      button('Start another call')!.click();
      await render(fixture);
      startRequest().flush({ ...CALL, conversationId: 'c2', callSid: 'WEBdef', sessionPath: '/api/voice/relay?token=t2' });
      await render(fixture);
      sockets[1]!.handlers.onOpen();
      await render(fixture);
      expect(sockets[1]!.path).toBe('/api/voice/relay?token=t2');
      expect(lines()).toEqual([`AI receptionist ${GREETING}`]);
      expect(ended()).toBeUndefined();
    });
  });

  describe('leaving', () => {
    it('leaving the page hangs up', async () => {
      await setup();
      const socket = await startCall();
      fixture.destroy();
      expect(socket.closed).toBe(true);
      expect(speech.cancelled).toBeGreaterThan(0);
    });

    it('a call belongs to one practice: switching practice hangs up and clears the screen', async () => {
      const practices = [{ ...PRACTICE_A, role: 'admin' as const }, { ...PRACTICE_B, role: 'admin' as const }];
      await setup({ practices });
      const socket = await startCall();

      const switching = TestBed.inject(AuthService).switchPractice(PRACTICE_B.id);
      http.expectOne('/api/auth/switch-practice').flush(makeSession({ practices, current: practices[1], token: 'beta' }));
      await switching;
      await render(fixture);

      expect(socket.closed).toBe(true);
      expect(lines()).toHaveLength(0);
      expect(button('Start a call')).toBeDefined();
      expect(root().textContent).not.toContain('Call ended');
    });

    it('a call that is still connecting when the practice changes is dropped, and its session never opens', async () => {
      const practices = [{ ...PRACTICE_A, role: 'admin' as const }, { ...PRACTICE_B, role: 'admin' as const }];
      await setup({ practices });
      await clickStart();
      const slow = startRequest();

      const switching = TestBed.inject(AuthService).switchPractice(PRACTICE_B.id);
      http.expectOne('/api/auth/switch-practice').flush(makeSession({ practices, current: practices[1], token: 'beta' }));
      await switching;
      await render(fixture);
      slow.flush(CALL);
      await render(fixture);
      expect(sockets).toHaveLength(0);
      expect(button('Start a call')).toBeDefined();
    });
  });
});
