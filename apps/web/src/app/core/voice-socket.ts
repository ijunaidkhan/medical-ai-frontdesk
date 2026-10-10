import { InjectionToken } from '@angular/core';

export interface VoiceSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
}

/** The part of a WebSocket the web phone uses, so tests can replace it. */
export interface VoiceSocket {
  send(data: string): void;
  close(): void;
}

export type OpenVoiceSocket = (path: string, handlers: VoiceSocketHandlers) => VoiceSocket;

/** Opens the live voice session on the same server as the page (the dev server and nginx both pass it through). */
export const OPEN_VOICE_SOCKET = new InjectionToken<OpenVoiceSocket>('OPEN_VOICE_SOCKET', {
  providedIn: 'root',
  factory: () => (path, handlers) => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`);
    socket.onopen = () => handlers.onOpen();
    socket.onmessage = (event) => handlers.onMessage(String(event.data));
    socket.onclose = () => handlers.onClose();
    return { send: (data) => socket.send(data), close: () => socket.close(1000) };
  },
});
