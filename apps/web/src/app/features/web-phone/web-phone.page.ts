import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { errorMessages, httpStatusOf } from '../../core/api/api-error';
import { VoiceApi } from '../../core/api/voice-api';
import { AuthService } from '../../core/auth/auth.service';
import { SpeechService, type Listening } from '../../core/speech.service';
import { OPEN_VOICE_SOCKET, type VoiceSocket } from '../../core/voice-socket';

interface Line {
  who: 'ai' | 'caller';
  text: string;
  /** Said under a line that was not simply written by the AI. */
  note: string | null;
}

type Phase = 'idle' | 'connecting' | 'live' | 'ended';
/** What is happening on the line right now. */
type Moment = 'speaking' | 'listening' | 'thinking';

const FIXED_MESSAGE_NOTE = 'Fixed safety message, not written by the AI. It cannot be talked over on a real call.';

const MOMENT_TEXT: Readonly<Record<Moment, string>> = {
  speaking: 'The receptionist is speaking…',
  listening: 'Listening…',
  thinking: 'The receptionist is thinking…',
};

const END_TEXT: Readonly<Record<string, string>> = {
  completed: 'The call ended: the receptionist finished the conversation.',
  handed_off: 'The call ended: it was handed to a person. On a real call, the caller would be transferred.',
  error: 'The call ended because something went wrong on the server.',
};

const OFF_TEXT = 'The web phone is switched off on this server. A developer turns it on with VOICE_PROVIDER=dev in the API settings (development only).';
const UNSUPPORTED_TEXT = 'This browser cannot listen and speak for the web phone. Use Chrome or Edge.';
const NOT_OPENED_TEXT = 'The voice session could not be opened. Start the call again.';

/**
 * Talk to the practice's AI receptionist by voice, as a caller would. The browser plays the part of the
 * phone provider: it turns speech into text, sends it over the same live session a real call uses, and
 * speaks the replies. Only one side talks at a time (the microphone is off while the receptionist speaks),
 * so the computer's speakers are not mistaken for the caller.
 */
@Component({
  selector: 'app-web-phone-page',
  imports: [RouterLink],
  templateUrl: './web-phone.page.html',
  styleUrl: './web-phone.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebPhonePage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(VoiceApi);
  private readonly speech = inject(SpeechService);
  private readonly openSocket = inject(OPEN_VOICE_SOCKET);

  protected readonly phase = signal<Phase>('idle');
  protected readonly moment = signal<Moment>('speaking');
  protected readonly lines = signal<Line[]>([]);
  /** The caller's words as they are being recognised. */
  protected readonly hearing = signal('');
  protected readonly problems = signal<string[]>([]);
  /** Whether the problems are about setup (so we can point to the settings page). */
  protected readonly setupProblem = signal(false);
  protected readonly conversationId = signal<string | null>(null);
  protected readonly endedText = signal('');
  protected readonly seconds = signal(0);

  protected readonly supported = this.speech.supported();
  protected readonly onCall = computed(() => this.phase() === 'connecting' || this.phase() === 'live');
  protected readonly momentText = computed(() => MOMENT_TEXT[this.moment()]);
  protected readonly clock = computed(() => `${String(Math.floor(this.seconds() / 60)).padStart(2, '0')}:${String(this.seconds() % 60).padStart(2, '0')}`);

  /** Bumped whenever a call starts or ends, so a late event from an old call is ignored. */
  private run = 0;
  private socket: VoiceSocket | null = null;
  private listening: Listening | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Set when the server says the session is over: the call ends once the last words are spoken. */
  private endReason: string | null = null;
  /** The receptionist's replies are spoken one after another. */
  private spoken: Promise<void> = Promise.resolve();

  constructor() {
    // A call belongs to one practice: leaving it for another hangs up and starts over.
    toObservable(this.auth.practiceId)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.discard());
    inject(DestroyRef).onDestroy(() => this.hangUpNow());
  }

  protected async start(): Promise<void> {
    if (this.onCall()) return;
    this.discard();
    if (!this.supported) {
      this.problems.set([UNSUPPORTED_TEXT]);
      return;
    }
    const run = this.run;
    this.phase.set('connecting');
    try {
      const call = await firstValueFrom(this.api.startWebCall());
      if (run !== this.run) return;
      this.conversationId.set(call.conversationId);
      this.socket = this.openSocket(call.sessionPath, {
        onOpen: () => this.onOpen(run, call.callSid, call.greeting),
        onMessage: (data) => this.onMessage(run, data),
        onClose: () => this.onClose(run),
      });
    } catch (error) {
      if (run !== this.run) return;
      this.phase.set('idle');
      const status = httpStatusOf(error);
      this.problems.set(status === 404 ? [OFF_TEXT] : errorMessages(error));
      this.setupProblem.set(status === 409);
    }
  }

  /** Cuts the receptionist off and goes back to listening. */
  protected interrupt(): void {
    this.speech.cancelSpeech();
  }

  protected hangUp(): void {
    this.hangUpNow();
    this.finish('You hung up.');
  }

  // ---------------------------------------------------------------- the live session

  private onOpen(run: number, callSid: string, greeting: string): void {
    if (run !== this.run) return;
    this.socket?.send(JSON.stringify({ type: 'setup', callSid }));
    this.phase.set('live');
    this.timer = setInterval(() => this.seconds.update((seconds) => seconds + 1), 1000);
    this.lines.set([{ who: 'ai', text: greeting, note: null }]);
    this.say(run, greeting);
  }

  private onMessage(run: number, data: string): void {
    if (run !== this.run) return;
    let message: { type?: unknown; token?: unknown; interruptible?: unknown; handoffData?: unknown };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    if (message.type === 'text' && typeof message.token === 'string') {
      const text = message.token;
      this.lines.update((lines) => [...lines, { who: 'ai', text, note: message.interruptible === false ? FIXED_MESSAGE_NOTE : null }]);
      this.say(run, text);
    } else if (message.type === 'end') {
      this.endReason = endReasonOf(message.handoffData);
      // After the words already queued, so a goodbye is always heard before the call ends.
      this.spoken = this.spoken.then(() => this.endCall(run));
    }
  }

  private onClose(run: number): void {
    if (run !== this.run) return;
    const neverOpened = this.phase() === 'connecting';
    this.hangUpNow();
    this.finish(neverOpened ? NOT_OPENED_TEXT : 'The call was closed by the server.');
  }

  /** Speaks the receptionist's words, then listens for the caller (unless the call is over). */
  private say(run: number, text: string): void {
    this.spoken = this.spoken.then(async () => {
      if (run !== this.run) return;
      this.moment.set('speaking');
      this.listening?.stop();
      await this.speech.speak(text);
      if (run === this.run && this.endReason === null) this.listen(run);
    });
  }

  private endCall(run: number): void {
    if (run !== this.run || this.endReason === null) return;
    const text = END_TEXT[this.endReason] ?? END_TEXT['completed']!;
    this.hangUpNow();
    this.finish(text);
  }

  private listen(run: number): void {
    this.moment.set('listening');
    this.hearing.set('');
    this.listening = this.speech.listen({
      onHearing: (text) => {
        if (run === this.run) this.hearing.set(text);
      },
      onSentence: (text) => {
        if (run === this.run) this.onSentence(text);
      },
      onProblem: (message) => {
        if (run !== this.run) return;
        this.hangUpNow();
        this.problems.set([message]);
        this.finish('The call ended because the microphone could not be used.');
      },
    });
  }

  private onSentence(text: string): void {
    this.hearing.set('');
    this.lines.update((lines) => [...lines, { who: 'caller', text, note: null }]);
    this.moment.set('thinking');
    this.socket?.send(JSON.stringify({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true }));
  }

  // ---------------------------------------------------------------- ending

  /** Closes everything belonging to the current call: session, microphone, speech and clock. Late events from it are ignored afterwards. */
  private hangUpNow(): void {
    this.run += 1;
    clearInterval(this.timer);
    this.listening?.stop();
    this.listening = null;
    this.socket?.close();
    this.socket = null;
    this.endReason = null;
    this.spoken = Promise.resolve();
    this.speech.cancelSpeech();
  }

  /** Shows that the call is over, and why. */
  private finish(text: string): void {
    this.hearing.set('');
    this.endedText.set(text);
    this.phase.set('ended');
  }

  /** Hangs up silently and clears the screen (a new call, or another practice). */
  private discard(): void {
    this.hangUpNow();
    this.phase.set('idle');
    this.lines.set([]);
    this.hearing.set('');
    this.problems.set([]);
    this.setupProblem.set(false);
    this.conversationId.set(null);
    this.endedText.set('');
    this.seconds.set(0);
  }
}

/** The reason in the server's "end" message, or "completed" when it is missing or odd. */
function endReasonOf(handoffData: unknown): string {
  try {
    const reason = (JSON.parse(String(handoffData)) as { reason?: unknown }).reason;
    return typeof reason === 'string' && reason in END_TEXT ? reason : 'completed';
  } catch {
    return 'completed';
  }
}
