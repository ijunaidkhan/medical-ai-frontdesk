import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { RelaySession } from './relay-session.js';
import { RelaySessions } from './relay-sessions.js';
import { RelayTokenService } from './relay-token.js';
import { isValidTwilioSignature } from './twilio-signature.js';
import { VoiceService } from './voice.service.js';

export const RELAY_PATH = '/api/voice/relay';
/** No message from Twilio is anywhere near this large; anything bigger is refused by the connection itself. */
const MAX_MESSAGE_BYTES = 64 * 1024;

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone' };

/**
 * Accepts the live voice sessions Twilio opens. Every check happens BEFORE the
 * connection is upgraded, so a request that fails any of them never becomes a
 * WebSocket and never reaches the receptionist:
 *
 *  1. voice is switched on (otherwise this does not exist);
 *  2. the address carries a valid, unexpired token (made when the call came in);
 *  3. Twilio's signature on the handshake is valid;
 *  4. the token's conversation is a live phone call of the token's practice;
 *  5. that conversation has not opened a session before (one session per call).
 *
 * Tenant and conversation come from the token, which only this server can make.
 */
@Injectable()
export class RelayGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly sessions = new RelaySessions();
  private readonly tokens: RelayTokenService;
  private readonly open = new Set<WebSocket>();
  private onUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly voice: VoiceService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RelayGateway.name);
    this.tokens = new RelayTokenService(this.config.get('ACCESS_TOKEN_SECRET', { infer: true }));
  }

  onApplicationBootstrap(): void {
    if (this.config.get('VOICE_PROVIDER', { infer: true }) !== 'twilio') {
      return; // voice is off: nothing listens, and a WebSocket request is just refused by the server
    }
    const server = this.adapterHost.httpAdapter.getHttpServer() as import('node:http').Server;
    this.onUpgrade = (request, socket, head) => {
      void this.handle(request, socket, head).catch((error: unknown) => {
        this.logger.error({ error: error instanceof Error ? error.name : 'unknown' }, 'A voice session request failed');
        this.refuse(socket, 400);
      });
    };
    server.on('upgrade', this.onUpgrade);
  }

  onApplicationShutdown(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as import('node:http').Server | undefined;
    if (this.onUpgrade) server?.off('upgrade', this.onUpgrade);
    for (const socket of this.open) socket.terminate();
    this.wss.close();
  }

  private async handle(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://placeholder');
    if (url.pathname !== RELAY_PATH) {
      return this.refuse(socket, 404); // some other WebSocket address: nothing here serves it
    }

    // 2. The token made when the call came in.
    const claims = await this.tokens.verify(url.searchParams.get('token') ?? '');
    if (!claims) {
      this.logger.warn('A voice session was refused: missing, wrong or expired token');
      return this.refuse(socket, 401);
    }

    // 3. Twilio's signature over the address it was told to open. Which scheme Twilio signs (wss or https) is
    //    not stated in its documentation, so the same address written either way is accepted; nothing else is.
    const header = request.headers['x-twilio-signature'];
    const authToken = this.config.get('TWILIO_AUTH_TOKEN', { infer: true }) ?? '';
    const base = this.config.get('PUBLIC_BASE_URL', { infer: true }) ?? '';
    const asHttps = `${base}${request.url}`;
    const asWss = asHttps.replace(/^http/, 'ws');
    const signature = typeof header === 'string' ? header : undefined;
    if (!isValidTwilioSignature(authToken, signature, asWss, {}) && !isValidTwilioSignature(authToken, signature, asHttps, {})) {
      this.logger.warn({ practiceId: claims.practiceId, hasSignature: signature !== undefined }, 'A voice session was refused: missing or wrong Twilio signature');
      return this.refuse(socket, 403);
    }

    // 4. A live phone call of that practice.
    const callSid = await this.voice.liveCallSid(claims.practiceId, claims.conversationId);
    if (!callSid) {
      this.logger.warn({ practiceId: claims.practiceId }, 'A voice session was refused: the call is not live');
      return this.refuse(socket, 410);
    }

    // 5. One session per call.
    if (!this.sessions.tryOpen(claims.conversationId)) {
      this.logger.warn({ practiceId: claims.practiceId, conversationId: claims.conversationId }, 'A voice session was refused: this call already had one');
      return this.refuse(socket, 409);
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => this.attach(ws, claims.practiceId, claims.conversationId, callSid));
  }

  private attach(ws: WebSocket, practiceId: string, conversationId: string, callSid: string): void {
    this.open.add(ws);
    const log = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => this.logger[level]({ practiceId, conversationId, ...fields }, message);
    const session = new RelaySession(
      {
        get open() {
          return ws.readyState === WebSocket.OPEN;
        },
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      },
      {
        expectedCallSid: callSid,
        answer: (text) => this.voice.answerCaller(practiceId, conversationId, text),
        onEnded: () => this.voice.endCall(practiceId, conversationId).catch((error: unknown) => log('error', { error: error instanceof Error ? error.name : 'unknown' }, 'Closing out a call failed')),
        log,
      },
    );
    log('info', {}, 'A voice session opened');
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) session.onMessage(data.toString('utf8')); // binary frames are not part of this protocol
    });
    ws.on('close', () => {
      this.open.delete(ws);
      log('info', {}, 'A voice session closed');
      void session.onClosed();
    });
    ws.on('error', () => ws.terminate());
  }

  /** Answers the handshake with an HTTP error and drops the connection: it never becomes a WebSocket. */
  private refuse(socket: Duplex, status: number): void {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
}
