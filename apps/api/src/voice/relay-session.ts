import { CALLER_MESSAGE_MAX_LENGTH, type AgentReply } from '@frontdesk/shared';
import { stripControl } from '../agent/sanitize.js';

/** Said, and then the call ends, when something goes wrong in the middle of a call. Fixed words: never anything a model or caller produced. */
export const SESSION_TROUBLE_TEXT =
  'I am sorry, something went wrong on our side. If this is a medical emergency, please hang up and call your local emergency number. Goodbye.';

/** Said when a session reaches its time limit. */
export const SESSION_LIMIT_TEXT =
  'I am sorry, this call has reached the longest time allowed. If this is a medical emergency, please hang up and call your local emergency number. Goodbye.';

/** A live session may not outlast this, whatever happens: it frees a connection that would otherwise be left open. */
export const MAX_SESSION_MS = 15 * 60_000;

/** After this many messages that are not valid JSON the session is closed (something is wrong or hostile). */
const MAX_BAD_MESSAGES = 5;

/** The small part of a WebSocket the session needs: easy to fake in tests. */
export interface SessionSocket {
  readonly open: boolean;
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface SessionHooks {
  /** The Twilio call id this session must belong to. */
  expectedCallSid: string;
  /** Runs one caller turn through the receptionist. */
  answer(text: string): Promise<AgentReply>;
  /** Called once when the session is over, however it ended. */
  onEnded(): Promise<void>;
  log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string): void;
}

type EndReason = 'completed' | 'handed_off' | 'error';

/** Reasons a reply must not be talked over: the fixed safety messages. */
const NOT_INTERRUPTIBLE = new Set<AgentReply['source']>(['scripted_emergency', 'scripted_urgent', 'scripted_limit', 'scripted_booking']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One live phone call, as Twilio's ConversationRelay talks to us. Twilio sends what
 * the caller says as text ("prompt"); each reply goes back as text and Twilio speaks it.
 *
 * Rules:
 *  - The call must say it is the call this session was opened for (`setup`) before anything else.
 *  - Caller turns are handled strictly one after another, so the transcript keeps its order
 *    even when the caller talks over the AI.
 *  - What the caller says is untrusted text: control characters are removed and it is cut to
 *    the same length limit as the text chat.
 *  - A failure never leaves silence: a fixed apology (with the emergency pointer) is spoken and the call ends.
 *  - Nothing the caller said is ever written to the log.
 */
export class RelaySession {
  private ready = false;
  private ended = false;
  private badMessages = 0;
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly socket: SessionSocket,
    private readonly hooks: SessionHooks,
    maxMs: number = MAX_SESSION_MS,
  ) {
    this.timer = setTimeout(() => void this.finish('completed', SESSION_LIMIT_TEXT, 1000), maxMs);
    this.timer.unref();
  }

  /** A message arrived from Twilio. Never throws. */
  onMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.countBad();
      return;
    }
    if (!isObject(message) || typeof message['type'] !== 'string') {
      this.countBad();
      return;
    }

    switch (message['type']) {
      case 'setup':
        this.onSetup(message);
        break;
      case 'prompt':
        this.onPrompt(message);
        break;
      case 'interrupt':
      case 'dtmf':
        break; // nothing to do: the AI's words are cut off by Twilio itself, and key presses are not used
      case 'error':
        this.hooks.log('warn', { description: typeof message['description'] === 'string' ? message['description'].slice(0, 200) : undefined }, 'Twilio reported a problem with the voice session');
        break;
      default:
        break; // a message type this version does not know: ignored, never interpreted
    }
  }

  /** The connection closed (the caller hung up, or Twilio ended the session). */
  async onClosed(): Promise<void> {
    this.ended = true;
    clearTimeout(this.timer);
    await this.queue; // let a turn in progress finish writing before the call is closed out
    await this.hooks.onEnded();
  }

  // ----------------------------------------------------------------------

  private onSetup(message: Record<string, unknown>): void {
    if (this.ready) {
      return; // a second setup changes nothing
    }
    if (message['callSid'] !== this.hooks.expectedCallSid) {
      // The session was opened for one call but Twilio says it is another: refuse, never talk to the wrong call.
      this.hooks.log('warn', {}, 'A voice session announced a different call than it was opened for; closing it');
      this.socket.close(1008, 'Wrong call');
      return;
    }
    this.ready = true;
  }

  private onPrompt(message: Record<string, unknown>): void {
    if (!this.ready) {
      this.hooks.log('warn', {}, 'A caller turn arrived before the session was set up; closing it');
      this.socket.close(1008, 'Not set up');
      return;
    }
    // Only the finished sentence is a turn (partial results are not requested, but never act on one).
    if (message['last'] === false || typeof message['voicePrompt'] !== 'string') {
      return;
    }
    const text = stripControl(message['voicePrompt']).trim().slice(0, CALLER_MESSAGE_MAX_LENGTH);
    if (text === '' || this.ended) {
      return;
    }
    this.queue = this.queue.then(() => this.handleTurn(text));
  }

  private async handleTurn(text: string): Promise<void> {
    if (this.ended) {
      return;
    }
    try {
      const reply = await this.hooks.answer(text);
      if (this.ended) {
        return; // the caller hung up (or the call ended) while the receptionist was thinking: nobody is there to hear it
      }
      this.speak(reply.reply, !NOT_INTERRUPTIBLE.has(reply.source));
      if (reply.status !== 'active') {
        this.end(reply.status === 'handed_off' ? 'handed_off' : 'completed');
      }
    } catch (error) {
      this.hooks.log('error', { error: error instanceof Error ? error.name : 'unknown' }, 'A caller turn failed; ending the call politely');
      await this.finish('error', SESSION_TROUBLE_TEXT, 1011);
    }
  }

  private speak(text: string, interruptible: boolean): void {
    this.send({ type: 'text', token: text, last: true, interruptible });
  }

  /** Tells Twilio the session is over; Twilio then asks us what to do with the call next. */
  private end(reason: EndReason): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.send({ type: 'end', handoffData: JSON.stringify({ reason }) });
  }

  private async finish(reason: EndReason, spoken: string, closeCode: number): Promise<void> {
    if (this.ended) return;
    this.speak(spoken, false);
    this.end(reason);
    // Give Twilio a moment to take the end message before the connection is closed.
    setTimeout(() => this.socket.close(closeCode, 'Ended'), 250).unref();
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket.open) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private countBad(): void {
    this.badMessages += 1;
    if (this.badMessages >= MAX_BAD_MESSAGES) {
      this.socket.close(1008, 'Invalid messages');
    }
  }
}
