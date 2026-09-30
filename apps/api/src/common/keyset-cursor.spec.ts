import { decodeCursor, encodeCursor } from './keyset-cursor.js';

// The audit log's own cursor tests (audit-cursor.spec.ts) also run against this code through its alias.
describe('keyset cursor (shared by every paged list)', () => {
  const cursor = { at: '2026-09-30 09:15:00.654321+00', id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' };

  it('round-trips with microsecond precision', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is URL-safe', () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(['', 'junk', Buffer.from('{}').toString('base64url'), Buffer.from('["x","y"]').toString('base64url')])(
    'rejects %j',
    (value) => {
      expect(decodeCursor(value)).toBeNull();
    },
  );
});
