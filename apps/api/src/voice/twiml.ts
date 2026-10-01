/**
 * TwiML is the XML that tells Twilio what to do with a call. Everything that goes
 * into it is escaped, because some of it is text a practice typed (its greeting,
 * its name, its emergency message): a greeting must never be able to add a
 * command of its own, for example a <Dial> to someone else's number.
 */

/** Characters XML 1.0 does not allow at all (everything below space except tab, newline, carriage return). */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const wrap = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const say = (text: string): string => `<Say language="en-US">${escapeXml(text)}</Say>`;

/** Politely ends the call. */
export function hangupResponse(): string {
  return wrap('<Hangup/>');
}

/**
 * Says something, then hangs up. Used when the AI cannot take the call: the words
 * are fixed text plus the practice's own safety messages, never anything a caller said.
 */
export function sayAndHangupResponse(...messages: string[]): string {
  return wrap(`${messages.filter((message) => message.trim() !== '').map(say).join('')}<Hangup/>`);
}

export interface RelayOptions {
  /** wss:// address Twilio opens to talk to us, with the one-time token. */
  relayUrl: string;
  /** Where Twilio asks what to do when the voice session ends. */
  actionUrl: string;
  /** Spoken first by Twilio. Includes the notice that the caller is talking to an AI. */
  greeting: string;
  language?: string;
  ttsProvider?: string | undefined;
  transcriptionProvider?: string | undefined;
}

/**
 * Connects the call to ConversationRelay: Twilio listens and speaks, and sends us
 * what the caller says as text. The greeting cannot be interrupted, so the AI
 * notice is always heard in full.
 */
export function connectRelayResponse(options: RelayOptions): string {
  const attributes: Array<[string, string]> = [
    ['url', options.relayUrl],
    ['welcomeGreeting', options.greeting],
    ['welcomeGreetingInterruptible', 'none'],
    ['language', options.language ?? 'en-US'],
    ['interruptible', 'speech'],
    ['dtmfDetection', 'false'],
  ];
  if (options.ttsProvider) attributes.push(['ttsProvider', options.ttsProvider]);
  if (options.transcriptionProvider) attributes.push(['transcriptionProvider', options.transcriptionProvider]);
  const rendered = attributes.map(([name, value]) => `${name}="${escapeXml(value)}"`).join(' ');
  return wrap(`<Connect action="${escapeXml(options.actionUrl)}"><ConversationRelay ${rendered}/></Connect>`);
}
