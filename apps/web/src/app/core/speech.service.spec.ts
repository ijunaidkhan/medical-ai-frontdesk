import { SpeechService, type ListenHandlers } from './speech.service';

type Result = ArrayLike<{ transcript: string }> & { isFinal: boolean };

/** The browser's speech recognition, replaced: the test makes it hear things and fail. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = true;
  interimResults = false;
  onresult: ((event: { results: Result[] }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  running = false;
  starts = 0;
  aborts = 0;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    if (this.running) throw new Error('InvalidStateError');
    this.running = true;
    this.starts += 1;
  }

  abort(): void {
    this.running = false;
    this.aborts += 1;
  }

  /** The browser stops listening by itself (after silence) and says so. */
  stopByItself(): void {
    this.running = false;
    this.onend?.();
  }
}

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = '';
  constructor(readonly text: string) {}
}

const heard = (transcript: string, isFinal: boolean): Result => Object.assign([{ transcript }], { isFinal });

describe('SpeechService', () => {
  let service: SpeechService;
  let spoken: FakeUtterance[];
  let cancels: number;

  beforeEach(() => {
    FakeRecognition.instances = [];
    spoken = [];
    cancels = 0;
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', { speak: (utterance: FakeUtterance) => spoken.push(utterance), cancel: () => (cancels += 1) });
    service = new SpeechService();
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('supported', () => {
    it('is true when the browser can recognise and speak', () => {
      expect(service.supported()).toBe(true);
    });

    it('is false without speech recognition (for example Firefox)', () => {
      vi.stubGlobal('webkitSpeechRecognition', undefined);
      expect(service.supported()).toBe(false);
    });
  });

  describe('listening', () => {
    function listen() {
      const events = { hearing: [] as string[], sentences: [] as string[], problems: [] as string[] };
      const handlers: ListenHandlers = {
        onHearing: (text) => events.hearing.push(text),
        onSentence: (text) => events.sentences.push(text),
        onProblem: (message) => events.problems.push(message),
      };
      const listening = service.listen(handlers);
      return { events, listening, recognition: FakeRecognition.instances[0]! };
    }

    it('listens to one English sentence at a time and reports words as they are recognised', () => {
      const { events, recognition } = listen();
      expect(recognition).toMatchObject({ lang: 'en-US', continuous: false, interimResults: true, running: true });
      recognition.onresult!({ results: [heard('I need an app', false)] });
      recognition.onresult!({ results: [heard('I need an appointment', false)] });
      expect(events.hearing).toEqual(['I need an app', 'I need an appointment']);
      expect(events.sentences).toEqual([]);
    });

    it('hands over the finished sentence once, and stops listening so the reply can be heard', () => {
      const { events, recognition } = listen();
      recognition.onresult!({ results: [heard('I need an appointment', true)] });
      expect(events.sentences).toEqual(['I need an appointment']);
      expect(recognition.aborts).toBe(1);
      recognition.stopByItself(); // the browser's own end event must not start it again
      expect(recognition.starts).toBe(1);
    });

    it('joins the parts of a sentence the browser reports separately', () => {
      const { events, recognition } = listen();
      recognition.onresult!({ results: [heard('I need', true), heard('an appointment', true)] });
      expect(events.sentences).toEqual(['I need an appointment']);
    });

    it('ignores an empty result', () => {
      const { events, recognition } = listen();
      recognition.onresult!({ results: [heard('  ', true)] });
      expect(events.sentences).toEqual([]);
    });

    it('starts again by itself when the browser stops after a silence, and keeps listening', () => {
      const { events, recognition } = listen();
      recognition.onerror!({ error: 'no-speech' });
      recognition.stopByItself();
      expect(recognition.starts).toBe(2);
      expect(recognition.running).toBe(true);
      expect(events.problems).toEqual([]);
    });

    it('does not start again after it was stopped', () => {
      const { listening, recognition } = listen();
      listening.stop();
      recognition.onend?.(); // already detached: nothing happens
      expect(recognition.starts).toBe(1);
      expect(recognition.aborts).toBe(1);
    });

    it('does not fail when the browser says it is already listening', () => {
      const { recognition } = listen();
      expect(() => recognition.onend!()).not.toThrow(); // start() throws "already started" and is ignored
    });

    it.each([
      ['not-allowed', /microphone is blocked/],
      ['service-not-allowed', /microphone is blocked/],
      ['audio-capture', /No microphone was found/],
      ['network', /needs an internet connection/],
      ['bad-grammar', /stopped working \(bad-grammar\)/],
    ])('reports %s as a problem in plain words, and stops', (error, message) => {
      const { events, recognition } = listen();
      recognition.onerror!({ error });
      expect(events.problems).toHaveLength(1);
      expect(events.problems[0]).toMatch(message);
      expect(recognition.aborts).toBe(1);
      expect(recognition.starts).toBe(1);
    });

    it('does not report "aborted" (it is what stopping causes)', () => {
      const { events, recognition } = listen();
      recognition.onerror!({ error: 'aborted' });
      expect(events.problems).toEqual([]);
    });
  });

  describe('speaking', () => {
    const finish = (utterance: FakeUtterance | undefined) => utterance!.onend!();

    it('speaks a sentence at a time, in order, and is done after the last', async () => {
      let done = false;
      const speaking = service.speak('Hello there. How can I help? We are open all day!').then(() => (done = true));
      expect(spoken.map((utterance) => utterance.text)).toEqual(['Hello there.']);
      expect(spoken[0]!.lang).toBe('en-US');
      finish(spoken[0]);
      finish(spoken[1]);
      expect(spoken.map((utterance) => utterance.text)).toEqual(['Hello there.', 'How can I help?', 'We are open all day!']);
      expect(done).toBe(false);
      finish(spoken[2]);
      await speaking;
      expect(done).toBe(true);
    });

    it('speaks text with no full stop as one piece', async () => {
      const speaking = service.speak('Thank you');
      finish(spoken[0]);
      await speaking;
      expect(spoken.map((utterance) => utterance.text)).toEqual(['Thank you']);
    });

    it('cancelling cuts the speech off and drops the sentences still waiting, even if the browser reports the cut as an ordinary end', async () => {
      const speaking = service.speak('One. Two. Three.');
      service.cancelSpeech();
      finish(spoken[0]); // the browser reports the cancelled sentence as ended
      await speaking;
      expect(cancels).toBe(1);
      expect(spoken).toHaveLength(1);
    });

    it('stops without speaking the rest when a sentence fails', async () => {
      const speaking = service.speak('One. Two.');
      spoken[0]!.onerror!();
      await speaking;
      expect(spoken).toHaveLength(1);
    });

    it('a new speech replaces one still waiting', async () => {
      const first = service.speak('Old one. Old two.');
      const second = service.speak('New one.');
      finish(spoken[0]); // the first sentence of the old speech ends: the old speech must not go on
      await first;
      expect(spoken.map((utterance) => utterance.text)).toEqual(['Old one.', 'New one.']);
      finish(spoken[1]);
      await second;
    });
  });
});
