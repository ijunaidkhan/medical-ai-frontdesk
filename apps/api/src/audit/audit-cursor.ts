import { isUuid } from '../common/uuid.js';

/** PostgreSQL's text form of a timestamptz, e.g. "2026-09-29 12:00:00.123456+00". */
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export interface AuditCursor {
  /** Exact database text of occurred_at (microseconds matter; a JS Date would lose them). */
  at: string;
  id: string;
}

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this API produced. */
export function decodeAuditCursor(value: string): AuditCursor | null {
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
