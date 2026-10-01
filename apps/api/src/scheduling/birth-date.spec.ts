import { isValidBirthDate } from '@frontdesk/shared';

const NOW = new Date('2026-10-01T12:00:00Z');

describe('isValidBirthDate', () => {
  it.each(['1990-05-17', '1900-01-01', '2026-10-01', '2026-10-02', '2000-02-29', '1999-12-31'])('accepts %s', (value) => {
    expect(isValidBirthDate(value, NOW)).toBe(true);
  });

  it.each([
    ['1899-12-31', 'before 1900'],
    ['2026-10-03', 'more than a day in the future'],
    ['2027-01-01', 'in the future'],
    ['2001-02-29', 'not a leap year'],
    ['1990-13-01', 'month 13'],
    ['1990-00-10', 'month 0'],
    ['1990-04-31', 'April has 30 days'],
    ['1990-05-00', 'day 0'],
    ['90-05-17', 'two-digit year'],
    ['1990/05/17', 'wrong separator'],
    ['17-05-1990', 'day first'],
    ['1990-5-7', 'no leading zeros'],
    ['1990-05-17T00:00:00Z', 'a time as well'],
    [' 1990-05-17', 'leading space'],
    ['', 'empty'],
    ['yesterday', 'words'],
  ])('refuses %s (%s)', (value) => {
    expect(isValidBirthDate(value, NOW)).toBe(false);
  });

  it('uses the current time by default', () => {
    expect(isValidBirthDate('1990-05-17')).toBe(true);
    expect(isValidBirthDate('9999-01-01')).toBe(false);
  });
});
