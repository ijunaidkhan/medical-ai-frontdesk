import { Injectable } from '@angular/core';

/** The few parts of the browser's speech recognition this app uses (TypeScript's DOM types do not include it). */
interface RecognitionEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

const recognitionConstructor = (): RecognitionConstructor | undefined => {
  const browser = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
};

const LANGUAGE = 'en-US';

/** Plain words for the errors that stop listening for good. Silence and "aborted" are not problems: listening just starts again. */
const LISTEN_PROBLEMS: Readonly<Record<string, string>> = {
  'not-allowed': 'The microphone is blocked. Allow it for this site (the icon next to the address), then start the call again.',
  'service-not-allowed': 'The microphone is blocked. Allow it for this site (the icon next to the address), then start the call again.',
  'audio-capture': 'No microphone was found. Connect one, then start the call again.',
  network: 'The browser’s speech service could not be reached. It needs an internet connection.',
};
const IGNORED_ERRORS = new Set(['no-speech', 'aborted']);

export interface ListenHandlers {
  /** The words heard so far in the sentence being spoken. */
  onHearing(text: string): void;
  /** A finished sentence. Listening has stopped by then; call listen() again for the next one. */
  onSentence(text: string): void;
  /** Listening cannot go on (microphone blocked, no internet, ...). */
  onProblem(message: string): void;
}

export interface Listening {
  stop(): void;
}

/**
 * The browser's own speech recognition and text-to-speech (the Web Speech API): free, no account.
 * In Chrome and Edge the audio is sent to Google's or Microsoft's speech service to be recognised.
 */
@Injectable({ providedIn: 'root' })
export class SpeechService {
  /** Bumped by cancelSpeech so a sentence still waiting to be spoken is dropped. */
  private speakRun = 0;

  supported(): boolean {
    return recognitionConstructor() !== undefined && 'speechSynthesis' in window;
  }

  /** Listens for one sentence at a time, restarting by itself through silences. */
  listen(handlers: ListenHandlers): Listening {
    const Recognition = recognitionConstructor();
    if (!Recognition) {
      return { stop: () => undefined };
    }
    const recognition = new Recognition();
    recognition.lang = LANGUAGE;
    recognition.continuous = false;
    recognition.interimResults = true;
    let active = true;

    const stop = () => {
      active = false;
      recognition.onresult = recognition.onerror = recognition.onend = null;
      recognition.abort();
    };
    const begin = () => {
      try {
        recognition.start();
      } catch {
        // already listening
      }
    };

    recognition.onresult = (event) => {
      const results = Array.from(event.results);
      const text = results.map((result) => result[0]?.transcript ?? '').join(' ').trim();
      if (results.at(-1)?.isFinal) {
        stop();
        if (text !== '') handlers.onSentence(text);
      } else {
        handlers.onHearing(text);
      }
    };
    recognition.onerror = (event) => {
      if (IGNORED_ERRORS.has(event.error)) return;
      stop();
      handlers.onProblem(LISTEN_PROBLEMS[event.error] ?? `Speech recognition stopped working (${event.error}).`);
    };
    recognition.onend = () => {
      if (active) begin();
    };
    begin();
    return { stop };
  }

  /** Speaks the text, a sentence at a time (some browsers cut off long speech). Resolves when done or cancelled. */
  speak(text: string): Promise<void> {
    const run = ++this.speakRun;
    const sentences = (text.match(/[^.!?]+[.!?]*/g) ?? [text]).map((sentence) => sentence.trim()).filter((sentence) => sentence !== '');
    return new Promise((resolve) => {
      const next = () => {
        const sentence = sentences.shift();
        if (sentence === undefined || run !== this.speakRun) {
          resolve();
          return;
        }
        const utterance = new SpeechSynthesisUtterance(sentence);
        utterance.lang = LANGUAGE;
        utterance.onend = next;
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
      };
      next();
    });
  }

  cancelSpeech(): void {
    this.speakRun += 1;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}
