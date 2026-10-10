import { isWebCallSid, newWebCallSid } from './web-call.js';

describe('web-phone call ids', () => {
  it('are unique, fit the database limit and are recognised', () => {
    const [first, second] = [newWebCallSid(), newWebCallSid()];
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9]{1,64}$/);
    expect(isWebCallSid(first)).toBe(true);
  });

  it('are never mistaken for a call id from Twilio (which starts with "CA")', () => {
    expect(isWebCallSid('CA00000000000000000000000000000001')).toBe(false);
    expect(isWebCallSid('')).toBe(false);
  });
});
