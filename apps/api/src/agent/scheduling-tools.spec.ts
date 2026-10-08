import { matchType, normalizePhone } from './scheduling-tools.js';

const types = [{ name: 'Follow-up' }, { name: 'Long visit' }, { name: 'Visit' }, { name: 'New patient visit' }];
const name = (wanted: string) => matchType(types, wanted)?.name;

describe('matchType (the visit the model meant)', () => {
  it.each([
    ['Follow-up', 'Follow-up'],
    ['follow up', 'Follow-up'],
    ['FOLLOW-UP', 'Follow-up'],
    ['a follow-up appointment', 'Follow-up'],
    ['long visit', 'Long visit'],
    ['a long visit please', 'Long visit'], // "visit" is in there too: the longest name that fits wins
    ['visit', 'Visit'],
    ['new patient visit, 40 minutes', 'New patient visit'],
    ['new patient', 'New patient visit'], // only one name contains it
  ])('%j is %j', (wanted, expected) => {
    expect(name(wanted)).toBe(expected);
  });

  it.each([['brain surgery'], [''], ['   '], ['--'], ['a'], ['pa']])('%j matches nothing (the model is shown the list instead)', (wanted) => {
    expect(name(wanted)).toBeUndefined();
  });

  it('refuses to guess between two names that both contain what was said', () => {
    expect(matchType([{ name: 'Short visit' }, { name: 'Long visit' }], 'visi')).toBeUndefined();
  });
});

describe('normalizePhone', () => {
  it('removes the spaces, dashes, dots and brackets people and models put in phone numbers', () => {
    expect(normalizePhone('+1 (415) 555-0133')).toBe('+14155550133');
    expect(normalizePhone('+92.300.123.4567')).toBe('+923001234567');
  });
});
