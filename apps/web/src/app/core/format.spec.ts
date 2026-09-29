import { formatDate, formatDateTime } from './format';

const INSTANT = '2026-09-29T18:05:00.000Z';

describe('formatDateTime', () => {
  it('shows the time in the practice’s own time zone', () => {
    expect(formatDateTime(INSTANT, 'America/New_York')).toContain('14:05');
    expect(formatDateTime(INSTANT, 'America/New_York')).toContain('2026');
    expect(formatDateTime(INSTANT, 'Asia/Karachi')).toContain('23:05');
    expect(formatDateTime(INSTANT, 'UTC')).toContain('18:05');
  });

  it('moves to the next day where the zone is ahead', () => {
    expect(formatDateTime('2026-09-29T22:30:00.000Z', 'Asia/Karachi')).toMatch(/^30 /);
  });

  it('falls back to the browser’s zone for a name it does not know', () => {
    expect(formatDateTime(INSTANT, 'Nowhere/Land')).not.toBe('');
  });

  it('falls back to the browser’s zone when none is given', () => {
    expect(formatDateTime(INSTANT, null)).not.toBe('');
    expect(formatDateTime(INSTANT, undefined)).not.toBe('');
  });

  it('returns nothing for a date it cannot read', () => {
    expect(formatDateTime('not a date', 'UTC')).toBe('');
  });
});

describe('formatDate', () => {
  it('uses the practice’s time zone to decide which day it is', () => {
    expect(formatDate('2026-09-29T22:30:00.000Z', 'UTC')).toMatch(/^29 /);
    expect(formatDate('2026-09-29T22:30:00.000Z', 'Asia/Karachi')).toMatch(/^30 /);
  });

  it('returns nothing for a date it cannot read', () => {
    expect(formatDate('', 'UTC')).toBe('');
  });
});
