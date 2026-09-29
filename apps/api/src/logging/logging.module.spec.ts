import { resolveRequestId } from './logging.module.js';

describe('resolveRequestId', () => {
  it('keeps a well-formed incoming ID', () => {
    expect(resolveRequestId('abc-12345678')).toBe('abc-12345678');
  });

  it('generates a UUID when none is supplied', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['contains a newline (log injection)', 'abcdefgh\n{"level":"fatal"}'],
    ['contains spaces', 'abcd efgh1234'],
  ])('replaces an unsafe incoming ID: %s', (_label, unsafe) => {
    const id = resolveRequestId(unsafe);
    expect(id).not.toBe(unsafe);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores repeated headers', () => {
    expect(resolveRequestId(['abc-12345678', 'def-12345678'])).toMatch(/^[0-9a-f-]{36}$/);
  });
});
