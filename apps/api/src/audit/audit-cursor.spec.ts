import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor.js';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const AT = '2026-09-29 12:00:00.123456+00';

describe('audit cursor', () => {
  it('round-trips, keeping microsecond precision that a JS Date would lose', () => {
    const cursor = { at: AT, id: ID };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it('is URL-safe', () => {
    expect(encodeAuditCursor({ at: AT, id: ID })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts timestamps without fractional seconds or with a minute offset', () => {
    for (const at of ['2026-09-29 12:00:00+00', '2026-09-29 12:00:00.5+05:30']) {
      expect(decodeAuditCursor(encodeAuditCursor({ at, id: ID }))).toEqual({ at, id: ID });
    }
  });

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each([
    ['not base64/JSON', '!!!not a cursor!!!'],
    ['empty', ''],
    ['JSON that is not an array', encode({ at: AT, id: ID })],
    ['wrong length', encode([AT])],
    ['extra element', encode([AT, ID, 'x'])],
    ['timestamp is not text', encode([12345, ID])],
    ['timestamp is malformed', encode(['yesterday', ID])],
    ['timestamp carries SQL', encode([`${AT}'; drop table audit_logs; --`, ID])],
    ['id is not a uuid', encode([AT, 'abc'])],
    ['id carries SQL', encode([AT, `${ID}'; drop table audit_logs; --`])],
  ])('rejects %s', (_label, value) => {
    expect(decodeAuditCursor(value)).toBeNull();
  });
});
