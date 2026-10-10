import { normalizePhone, PHONE_FORMAT_NOTE, phoneWasSaid, volunteeredPhone } from './spoken-phone.js';

describe('normalizePhone', () => {
  it('removes the spaces, dashes, dots and brackets people, speech recognition and models put in phone numbers', () => {
    expect(normalizePhone('+1 (415) 555-0133')).toBe('+14155550133');
    expect(normalizePhone('+92.300.123.4567')).toBe('+923001234567');
    expect(normalizePhone('+92 33357 50966')).toBe('+923335750966'); // from a real web-phone call
  });

  it('keeps the plus sign and the digits, and does not invent either', () => {
    expect(normalizePhone('+923335750966')).toBe('+923335750966');
    expect(normalizePhone('0333 5750966')).toBe('03335750966');
    expect(normalizePhone('')).toBe('');
  });
});

describe('volunteeredPhone (a number the caller already gave is not asked for again)', () => {
  it('finds the one number said in full, with its country code, however it is written', () => {
    expect(volunteeredPhone('Hi, I am Sara Ali, phone +1 415 555 0177, born 3 February 1991')).toBe('+14155550177');
    expect(volunteeredPhone('my number is +92 33357 50966')).toBe('+923335750966');
    expect(volunteeredPhone('+1 (415) 555-0177')).toBe('+14155550177');
  });

  it('counts a number repeated in the same words once', () => {
    expect(volunteeredPhone('it is +1 415 555 0177. Yes, +14155550177.')).toBe('+14155550177');
  });

  it('gives nothing when the caller said no number, two different ones, or one without a country code', () => {
    expect(volunteeredPhone('I would like an appointment, born 3 February 1991')).toBeNull();
    expect(volunteeredPhone('call +1 415 555 0177 or +1 415 555 0188')).toBeNull();
    expect(volunteeredPhone('my number is 415 555 0177')).toBeNull(); // which country is not known
    expect(volunteeredPhone('')).toBeNull();
  });

  it('is not fooled by dates, ages or other numbers', () => {
    expect(volunteeredPhone('born on 12 March 1988, I need 3 tablets for 2 weeks')).toBeNull();
    expect(volunteeredPhone('born 1988-03-12 and my number is +1 415 555 0177')).toBe('+14155550177');
  });

  it('gives nothing for a number that cannot be a phone number', () => {
    expect(volunteeredPhone('+12345')).toBeNull(); // too short
    expect(volunteeredPhone('+0415 555 0177')).toBeNull(); // a country code cannot start with 0
  });
});

describe('PHONE_FORMAT_NOTE', () => {
  it('tells the model to fix the number itself and not to ask the caller to change how they say it', () => {
    expect(PHONE_FORMAT_NOTE).toContain('Write the number yourself');
    expect(PHONE_FORMAT_NOTE).toContain('never ask the caller to say it differently');
  });
});

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
