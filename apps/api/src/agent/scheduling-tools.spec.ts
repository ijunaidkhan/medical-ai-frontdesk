import { digitsSaid, matchType, normalizePhone, phoneWasSaid } from './scheduling-tools.js';

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

describe('phoneWasSaid (the number the model passes must be one the caller said)', () => {
  const caller = 'Hi, this is Sara Ali, date of birth 3 February 1991, phone number +1 415 555 0111.';

  it('accepts the number as said, however it was written', () => {
    expect(phoneWasSaid('+14155550111', caller)).toBe(true);
    expect(phoneWasSaid('+14155550111', 'my number is 415-555-0111')).toBe(true); // no country code said
    expect(phoneWasSaid('+923001234567', 'call me on 0300 1234567')).toBe(true); // a local Pakistani number
    expect(phoneWasSaid('+14155550111', 'four one five, five five five, oh one one one')).toBe(true); // spoken, on the phone
  });

  it('refuses a number with a digit dropped, added or changed (seen with a small model)', () => {
    expect(phoneWasSaid('+1415550111', caller)).toBe(false);
    expect(phoneWasSaid('+141555550111', caller)).toBe(false);
    expect(phoneWasSaid('+14155550112', caller)).toBe(false);
    expect(phoneWasSaid('+1415555011', caller)).toBe(false); // the last digit dropped
    expect(phoneWasSaid('+4155550111', caller)).toBe(false); // the country code dropped (not a valid number either)
    expect(phoneWasSaid('+19914155550111', caller)).toBe(false); // part of the birth year run into it
  });

  it('refuses a number the caller never gave', () => {
    expect(phoneWasSaid('+14155550111', 'I want to cancel my appointment')).toBe(false);
    expect(phoneWasSaid('', caller)).toBe(false);
  });

  it('reads spoken digits', () => {
    expect(digitsSaid('Oh three zero zero, one two three')).toBe('0300123');
  });
});

describe('normalizePhone', () => {
  it('removes the spaces, dashes, dots and brackets people and models put in phone numbers', () => {
    expect(normalizePhone('+1 (415) 555-0133')).toBe('+14155550133');
    expect(normalizePhone('+92.300.123.4567')).toBe('+923001234567');
  });
});
