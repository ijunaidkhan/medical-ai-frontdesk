import WebSocket from 'ws';

export interface VoiceClient {
  ws: WebSocket;
  received: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

/** The handshake was refused with this HTTP status (it never became a WebSocket). */
export class Refused extends Error {
  constructor(readonly status: number) {
    super(`refused with ${status}`);
  }
}

export const until = async (condition: () => boolean | Promise<boolean>, what = 'the condition', ms = 4_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** Opens a WebSocket the way a client would. `opened` collects every socket so the test can close them afterwards. */
export function openVoiceClient(url: string, opened: WebSocket[], headers: Record<string, string> = {}): Promise<VoiceClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    opened.push(ws);
    const received: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    ws.once('open', () => resolve({ ws, received, closed }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Refused(response.statusCode ?? 0));
    });
    ws.once('error', (error) => reject(error));
  });
}

/** 'opened', or the HTTP status the handshake was refused with. */
export const refusedWith = (promise: Promise<VoiceClient>): Promise<string | number> =>
  promise.then(
    () => 'opened',
    (error: unknown) => (error instanceof Refused ? error.status : `failed: ${String(error)}`),
  );
