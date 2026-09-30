import { isUuid } from './uuid.js';

/** PostgreSQL's text form of a timestamptz, e.g. "2026-09-29 12:00:00.123456+00". */
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

/**
 * A position in a list ordered by (timestamp, id) descending. Used by every
 * paged list so that rows sharing a timestamp are never skipped or repeated.
 */
export interface Cursor {
  /** Exact database text of the timestamp (microseconds matter; a JS Date would lose them). */
  at: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this API produced. */
export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return null;
    }
    const [at, id] = parsed as [unknown, unknown];
    return typeof at === 'string' && TIMESTAMP_TEXT.test(at) && isUuid(id) ? { at, id } : null;
  } catch {
    return null;
  }
}
