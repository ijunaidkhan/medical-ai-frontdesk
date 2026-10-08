import { phoneWasSaid } from './spoken-phone.js';

describe('phoneWasSaid (a number the receptionist saves must be one the caller said)', () => {
  const caller = 'Hi, this is Sara Ali, date of birth 3 February 1991, phone number +1 415 555 0111.';

  it('accepts the number as said, however it was written', () => {
    expect(phoneWasSaid('+14155550111', caller)).toBe(true);
    expect(phoneWasSaid('+14155550111', 'my number is 415-555-0111')).toBe(true); // no country code said
    expect(phoneWasSaid('+923001234567', 'call me on 0300 1234567')).toBe(true); // a local Pakistani number
    expect(phoneWasSaid('+14155550111', 'four one five, five five five, oh one one one')).toBe(true); // spoken, on the phone
    expect(phoneWasSaid('+923001234567', 'Oh three zero zero, one two three four five six seven')).toBe(true);
  });

  it('refuses a number with a digit dropped, added or changed (seen with a small model)', () => {
    expect(phoneWasSaid('+1415550111', caller)).toBe(false);
    expect(phoneWasSaid('+141555550111', caller)).toBe(false);
    expect(phoneWasSaid('+14155550112', caller)).toBe(false);
    expect(phoneWasSaid('+1415555011', caller)).toBe(false); // the last digit dropped
    expect(phoneWasSaid('+4155550111', caller)).toBe(false); // the country code dropped (not a valid number either)
    expect(phoneWasSaid('+19914155550111', caller)).toBe(false); // part of the birth year run into it
  });

  it('refuses a number the caller never gave, including the placeholder numbers models make up', () => {
    expect(phoneWasSaid('+14155550111', 'I want to cancel my appointment')).toBe(false);
    expect(phoneWasSaid('+1234567890', 'I want to book an appointment, my name is Zara')).toBe(false); // invented in a real chat
    expect(phoneWasSaid('', caller)).toBe(false);
  });

  it('an empty number is never "said"', () => {
    expect(phoneWasSaid('', 'my number is +1 415 555 0111')).toBe(false);
    expect(phoneWasSaid('+', '')).toBe(false);
  });

  it('a number said with a plus sign must match exactly', () => {
    expect(phoneWasSaid('+14155550111', 'call me on +4155550111')).toBe(false);
  });
});
