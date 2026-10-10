import { dateNotSaidMessage, dateWasSaid } from './spoken-date.js';

describe('dateWasSaid (a date of birth the receptionist saves must be one the caller said)', () => {
  it.each([
    'My date of birth is 3 February 1991.',
    'born on the 3rd of February 1991',
    'february 3rd, 1991',
    'February 3 1991',
    'Feb 3rd 1991 please',
    'feb. 3, 1991',
    '1991 february 3',
    '1991-02-03',
    '03/02/1991',
    '3-2-1991',
    '3.2.1991',
    '3 2 1991',
    '2/3/1991', // the other reading of the same digits: the model decides which, the read-back checks it
    '3 february 91',
    'my name is Sara Ali, i was born 3 February 1991 and my number is something',
  ])('accepts 1991-02-03 said as: %s', (said) => {
    expect(dateWasSaid('1991-02-03', said)).toBe(true);
  });

  it.each([
    ['a different day', '4 February 1991'],
    ['a different month', '3 March 1991'],
    ['a different year', '3 February 1992'],
    ['a year with a digit changed (speech recognition)', '3 February 1981'],
    ['a two-digit year that does not match', '3 february 92'],
    ['no date at all', 'I would like an appointment next week'],
    ['only some of the date', 'february 1991'],
    ['only the day and month', '3 february'],
    ['a date in words only (not recognised)', 'the third of february nineteen ninety one'],
    ['empty', ''],
  ])('refuses 1991-02-03 when the caller said %s', (_label, said) => {
    expect(dateWasSaid('1991-02-03', said)).toBe(false);
  });

  it('refuses a date nobody said even when other numbers are in the conversation', () => {
    expect(dateWasSaid('1991-02-03', 'my number is 415 555 0111 and I need 3 tablets for 2 weeks')).toBe(false);
  });

  it('reads the month names people use, including the short forms', () => {
    expect(dateWasSaid('1985-09-12', '12 sept 1985')).toBe(true);
    expect(dateWasSaid('1985-09-12', '12 September 1985')).toBe(true);
    expect(dateWasSaid('1985-12-09', 'dec 9 1985')).toBe(true);
    expect(dateWasSaid('2004-05-30', '30th may 2004')).toBe(true);
  });

  it('does not accept a date that is not written YYYY-MM-DD, whatever was said', () => {
    expect(dateWasSaid('3 February 1991', '3 February 1991')).toBe(false);
    expect(dateWasSaid('1991-2-3', '3 February 1991')).toBe(false);
    expect(dateWasSaid('', '3 February 1991')).toBe(false);
  });

  it('tells the model what to do when the date was not said', () => {
    expect(dateNotSaidMessage('1991-02-03')).toContain('1991-02-03');
    expect(dateNotSaidMessage('1991-02-03')).toContain('say their date of birth again');
  });
});
