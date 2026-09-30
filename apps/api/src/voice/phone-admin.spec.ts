import { parsePhoneArgs, PhoneAdminError } from './phone-admin.js';

describe('parsePhoneArgs', () => {
  it('reads add with all its options', () => {
    expect(parsePhoneArgs(['add', '--practice', 'alpha', '--number', '+14155550123', '--label', 'Main line', '--sid', 'PN123'])).toEqual({
      command: 'add',
      practice: 'alpha',
      number: '+14155550123',
      label: 'Main line',
      providerSid: 'PN123',
    });
  });

  it('the label and Twilio id are optional, and the order of options does not matter', () => {
    expect(parsePhoneArgs(['add', '--number', '+14155550123', '--practice', 'alpha'])).toEqual({ command: 'add', practice: 'alpha', number: '+14155550123' });
  });

  it('reads list, enable and disable', () => {
    expect(parsePhoneArgs(['list'])).toEqual({ command: 'list' });
    expect(parsePhoneArgs(['enable', '--number', '+14155550123'])).toEqual({ command: 'enable', number: '+14155550123' });
    expect(parsePhoneArgs(['disable', '--number', '+14155550123'])).toEqual({ command: 'disable', number: '+14155550123' });
  });

  it.each([
    ['nothing', []],
    ['an unknown command', ['remove', '--number', '+14155550123']],
    ['add without a practice', ['add', '--number', '+14155550123']],
    ['add without a number', ['add', '--practice', 'alpha']],
    ['an unknown option', ['add', '--practice', 'alpha', '--number', '+14155550123', '--colour', 'red']],
    ['an option for another command', ['enable', '--number', '+14155550123', '--label', 'x']],
    ['an option without a value', ['add', '--practice', '--number', '+14155550123']],
    ['a trailing option without a value', ['add', '--practice', 'alpha', '--number']],
    ['the same option twice', ['add', '--practice', 'alpha', '--practice', 'beta', '--number', '+14155550123']],
    ['a value that is not an option', ['add', 'alpha', '+14155550123']],
    ['list with extras', ['list', '--number', '+14155550123']],
  ])('refuses %s, with the usage text', (_name, argv) => {
    expect(() => parsePhoneArgs(argv)).toThrow(PhoneAdminError);
    expect(() => parsePhoneArgs(argv)).toThrow(/Usage:/);
  });
});
