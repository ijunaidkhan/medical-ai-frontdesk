import type { AgentReply } from '@frontdesk/shared';
import { checkReply } from '../agent/safety/output-guard.js';
import { RelaySession, SESSION_LIMIT_TEXT, SESSION_TROUBLE_TEXT, type SessionHooks, type SessionSocket } from './relay-session.js';

const CALL_SID = 'CA00000000000000000000000000000001';

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

function setup(options: { answer?: SessionHooks['answer']; maxMs?: number } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const closes: Array<[number, string]> = [];
  const socket: SessionSocket & { isOpen: boolean } = {
    isOpen: true,
    get open() {
      return this.isOpen;
    },
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: (code, why) => closes.push([code, why]),
  };
  const asked: string[] = [];
  const logs: unknown[] = [];
  const onEnded = vi.fn(() => Promise.resolve());
  const hooks: SessionHooks = {
    expectedCallSid: CALL_SID,
    answer:
      options.answer ??
      ((text) => {
        asked.push(text);
        return Promise.resolve(reply());
      }),
    onEnded,
    log: (level, fields, message) => logs.push({ level, fields, message }),
  };
  const session = new RelaySession(socket, hooks, options.maxMs);
  const message = (payload: unknown) => session.onMessage(JSON.stringify(payload));
  const setupMessage = () => message({ type: 'setup', callSid: CALL_SID, from: '+16505550199', to: '+14155550123' });
  const prompt = (voicePrompt: unknown, extra: Record<string, unknown> = {}) => message({ type: 'prompt', voicePrompt, lang: 'en-US', last: true, ...extra });
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return { session, socket, sent, closes, asked, logs, onEnded, message, setupMessage, prompt, settle };
}

describe('RelaySession', () => {
  afterEach(() => vi.useRealTimers());

  describe('the call must identify itself first', () => {
    it('accepts a setup for the call it was opened for', async () => {
      const { setupMessage, prompt, settle, sent, closes } = setup();
      setupMessage();
      prompt('hello');
      await settle();
      expect(closes).toEqual([]);
      expect(sent).toHaveLength(1);
    });

    it('closes the session when Twilio says it is a different call', () => {
      const { message, closes, sent } = setup();
      message({ type: 'setup', callSid: 'CA00000000000000000000000000000002' });
      expect(closes).toEqual([[1008, 'Wrong call']]);
      expect(sent).toEqual([]);
    });

    it.each([[undefined], [''], [42], [{}]])('treats a setup with call id %j as a different call', (callSid) => {
      const { message, closes } = setup();
      message({ type: 'setup', callSid });
      expect(closes).toEqual([[1008, 'Wrong call']]);
    });

    it('closes the session when the caller turn arrives before setup, and never asks the receptionist', async () => {
      const { prompt, closes, asked, settle } = setup();
      prompt('hello');
      await settle();
      expect(closes).toEqual([[1008, 'Not set up']]);
      expect(asked).toEqual([]);
    });

    it('a second setup changes nothing', async () => {
      const { setupMessage, message, prompt, settle, closes, asked } = setup();
      setupMessage();
      message({ type: 'setup', callSid: 'CA00000000000000000000000000000002' }); // ignored, not a reason to close
      prompt('hello');
      await settle();
      expect(closes).toEqual([]);
      expect(asked).toEqual(['hello']);
    });
  });

  describe('a caller turn', () => {
    it('is answered by the receptionist and the reply is sent back as text for Twilio to speak', async () => {
      const { setupMessage, prompt, settle, sent, asked } = setup();
      setupMessage();
      prompt('What are your hours?');
      await settle();
      expect(asked).toEqual(['What are your hours?']);
      expect(sent).toEqual([{ type: 'text', token: 'We are open Monday to Friday.', last: true, interruptible: true }]);
    });

    it.each([
      ['scripted_emergency', false],
      ['scripted_urgent', false],
      ['scripted_limit', false],
      ['scripted_guard', true],
      ['model', true],
    ] as const)('a %s reply is interruptible: %s (fixed safety messages are always heard in full)', async (source, interruptible) => {
      const { setupMessage, prompt, settle, sent } = setup({ answer: () => Promise.resolve(reply({ source })) });
      setupMessage();
      prompt('hello');
      await settle();
      expect(sent[0]).toMatchObject({ type: 'text', interruptible });
    });

    it('turns are handled strictly one after another, even when they arrive together', async () => {
      const order: string[] = [];
      const gates: Array<() => void> = [];
      const { setupMessage, prompt, settle, sent } = setup({
        answer: (text) => {
          order.push(`start ${text}`);
          return new Promise((resolve) => gates.push(() => { order.push(`finish ${text}`); resolve(reply({ reply: `answer to ${text}` })); }));
        },
      });
      setupMessage();
      prompt('one');
      prompt('two');
      prompt('three');
      await settle();
      expect(order).toEqual(['start one']); // the others wait their turn
      gates.shift()!();
      await settle();
      gates.shift()!();
      await settle();
      gates.shift()!();
      await settle();
      expect(order).toEqual(['start one', 'finish one', 'start two', 'finish two', 'start three', 'finish three']);
      expect(sent.map((m) => m['token'])).toEqual(['answer to one', 'answer to two', 'answer to three']);
    });

    it('ignores partial results, empty speech, and anything that is not text', async () => {
      const { setupMessage, prompt, message, settle, asked } = setup();
      setupMessage();
      prompt('half a sent', { last: false });
      prompt('');
      prompt('   \n ');
      prompt(42);
      prompt(undefined);
      message({ type: 'prompt' });
      await settle();
      expect(asked).toEqual([]);
    });

    it('cleans what the caller said: control characters out, spaces trimmed, and cut at the text chat’s length limit', async () => {
      const { setupMessage, prompt, settle, asked } = setup();
      setupMessage();
      prompt('  hel\u0000lo\u0007 there  ');
      prompt('x'.repeat(5_000));
      await settle();
      expect(asked[0]).toBe('hello there');
      expect(asked[1]).toHaveLength(2_000);
    });

    it('never writes what the caller said to the log', async () => {
      const { setupMessage, prompt, settle, logs } = setup({ answer: () => Promise.reject(new Error('boom: my secret chest pain')) });
      setupMessage();
      prompt('my private words about chest pain');
      await settle();
      expect(logs.length).toBeGreaterThan(0);
      expect(JSON.stringify(logs)).not.toContain('private words');
      expect(JSON.stringify(logs)).not.toContain('secret chest pain'); // not even the error's own text
    });
  });

  describe('when the conversation ends', () => {
    it.each([
      ['completed', 'completed'],
      ['handed_off', 'handed_off'],
    ] as const)('a %s conversation: the reply is sent, then the session is ended with the reason', async (status, reason) => {
      const { setupMessage, prompt, settle, sent } = setup({ answer: () => Promise.resolve(reply({ status, reply: 'Goodbye.' })) });
      setupMessage();
      prompt('bye');
      await settle();
      expect(sent).toEqual([
        { type: 'text', token: 'Goodbye.', last: true, interruptible: true },
        { type: 'end', handoffData: JSON.stringify({ reason }) },
      ]);
    });

    it('ignores anything the caller says after the end', async () => {
      const { setupMessage, prompt, settle, sent, asked } = setup({ answer: () => Promise.resolve(reply({ status: 'completed' })) });
      setupMessage();
      prompt('bye');
      prompt('wait, one more thing');
      await settle();
      expect(sent.filter((m) => m['type'] === 'end')).toHaveLength(1);
      expect(sent.filter((m) => m['type'] === 'text')).toHaveLength(1);
      expect(asked).toEqual([]); // (the custom answer function does not record; the point is no second reply was sent)
    });

    it('closing out the call runs once the connection closes, after a turn in progress has finished', async () => {
      let release: (value: AgentReply) => void = () => undefined;
      const { setupMessage, prompt, settle, session, onEnded, sent } = setup({ answer: () => new Promise((resolve) => (release = resolve)) });
      setupMessage();
      prompt('hello');
      await settle();
      const closing = session.onClosed();
      await settle();
      expect(onEnded).not.toHaveBeenCalled(); // still waiting for the turn in progress
      release(reply());
      await closing;
      expect(onEnded).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([]); // the caller had gone: nothing is sent to a closed call
    });
  });

  describe('when something goes wrong, the caller is never left in silence', () => {
    it('speaks a fixed apology with the emergency pointer, ends the session as an error, and closes it', async () => {
      vi.useFakeTimers();
      const { setupMessage, prompt, settle, sent, closes } = setup({ answer: () => Promise.reject(new Error('database is down')) });
      setupMessage();
      prompt('hello');
      await vi.advanceTimersByTimeAsync(0);
      await settle();
      expect(sent).toEqual([
        { type: 'text', token: SESSION_TROUBLE_TEXT, last: true, interruptible: false },
        { type: 'end', handoffData: JSON.stringify({ reason: 'error' }) },
      ]);
      expect(sent[0]!['token']).toContain('medical emergency');
      expect(closes).toEqual([]); // the connection is closed a moment later so Twilio can take the end message
      await vi.advanceTimersByTimeAsync(300);
      expect(closes).toEqual([[1011, 'Ended']]);
    });

    it('the fixed apology and the time-limit message themselves pass the reply checker', () => {
      expect(checkReply(SESSION_TROUBLE_TEXT)).toEqual({ ok: true });
      expect(checkReply(SESSION_LIMIT_TEXT)).toEqual({ ok: true });
    });

    it('ends a call that goes on too long, with a goodbye', async () => {
      vi.useFakeTimers();
      const { sent, closes } = setup({ maxMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([
        { type: 'text', token: SESSION_LIMIT_TEXT, last: true, interruptible: false },
        { type: 'end', handoffData: JSON.stringify({ reason: 'completed' }) },
      ]);
      await vi.advanceTimersByTimeAsync(300);
      expect(closes).toEqual([[1000, 'Ended']]);
    });

    it('sends nothing once the connection is no longer open', async () => {
      const { setupMessage, prompt, settle, sent, socket } = setup();
      setupMessage();
      socket.isOpen = false;
      prompt('hello');
      await settle();
      expect(sent).toEqual([]);
    });
  });

  describe('messages that are not what Twilio sends', () => {
    it('ignores types it does not know, and the ones that need no action', async () => {
      const { setupMessage, message, settle, sent, closes } = setup();
      setupMessage();
      message({ type: 'interrupt', utteranceUntilInterrupt: 'hel', durationUntilInterruptMs: 300 });
      message({ type: 'dtmf', digit: '5' });
      message({ type: 'error', description: 'speech engine unavailable' });
      message({ type: 'something-new', anything: true });
      await settle();
      expect(sent).toEqual([]);
      expect(closes).toEqual([]);
    });

    it('closes the session after repeated rubbish, but not after one slip', () => {
      const { session, closes } = setup();
      session.onMessage('not json');
      session.onMessage('[1,2,3]');
      session.onMessage('"text"');
      session.onMessage('{"no":"type"}');
      expect(closes).toEqual([]);
      session.onMessage('{"type": 5}');
      expect(closes).toEqual([[1008, 'Invalid messages']]);
    });

    it('never throws, whatever it is given', () => {
      const { session } = setup();
      for (const raw of ['', 'null', '0', 'true', '{}', '[]', '{"type":"prompt"}', '{"type":"setup"}', '\u0000', 'x'.repeat(100_000)]) {
        expect(() => session.onMessage(raw)).not.toThrow();
      }
    });
  });
});
