import { createHmac, timingSafeEqual } from 'node:crypto';

/** What Twilio sends as form fields: a value, or a list when a field is repeated. */
export type TwilioParams = Record<string, string | string[] | undefined>;

/**
 * Twilio's webhook signature: HMAC-SHA1, keyed by the account's auth token, over
 * the exact public URL followed by every parameter as name+value, names sorted
 * (a repeated field contributes each distinct value, sorted), base64 encoded.
 * Written to match Twilio's own libraries, and tested against signatures made by
 * the official SDK (see twilio-signature.spec.ts).
 */
export function expectedTwilioSignature(authToken: string, url: string, params: TwilioParams): string {
  let data = url;
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? [...new Set(value)].sort() : [value];
    for (const single of values) data += name + single;
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/**
 * Twilio is inconsistent about whether the address it signed includes the default
 * port (:443 or :80), so both spellings are accepted. No other variation is: the
 * path, the query string and the host must match exactly.
 */
export function urlSpellings(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  if (!secure && parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') return [];
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const credentials = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
  if (parsed.port !== '') {
    // A port that is not the default is part of the address and must match as written.
    return [`${parsed.protocol}//${credentials}${parsed.host}${rest}`];
  }
  const standard = secure ? ':443' : ':80';
  return [`${parsed.protocol}//${credentials}${parsed.host}${rest}`, `${parsed.protocol}//${credentials}${parsed.host}${standard}${rest}`];
}

/** True only for a signature made with this token over this URL and these parameters. Constant-time comparison. */
export function isValidTwilioSignature(authToken: string, header: string | undefined, url: string, params: TwilioParams): boolean {
  const provided = Buffer.from((header ?? '').trim(), 'utf8');
  if (provided.length === 0 || authToken.length === 0) return false;
  let valid = false;
  for (const spelling of urlSpellings(url)) {
    const expected = Buffer.from(expectedTwilioSignature(authToken, spelling, params), 'utf8');
    // Every candidate is compared (no early exit), so timing never reveals which one matched.
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) valid = true;
  }
  return valid;
}
