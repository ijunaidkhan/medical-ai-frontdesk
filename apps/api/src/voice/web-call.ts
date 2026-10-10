import { randomUUID } from 'node:crypto';

/** Web-phone call ids start with this. Twilio's start with "CA", so the two can never be mistaken for each other. */
const WEB_CALL_PREFIX = 'WEB';

export const newWebCallSid = (): string => `${WEB_CALL_PREFIX}${randomUUID().replace(/-/g, '')}`;

export const isWebCallSid = (callSid: string): boolean => callSid.startsWith(WEB_CALL_PREFIX);
