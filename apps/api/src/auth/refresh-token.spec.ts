import { createRefreshToken, hashRefreshToken, parseRefreshToken } from './refresh-token.js';

const PRACTICE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_PRACTICE = '0190ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('refresh tokens', () => {
  it('creates a token that names its practice and carries 256 bits of randomness', () => {
    const { value, hash } = createRefreshToken(PRACTICE);
    expect(value).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(value.startsWith(`${PRACTICE}.`)).toBe(true);
    expect(hash).toHaveLength(32);
  });

  it('never repeats', () => {
    const values = new Set(Array.from({ length: 200 }, () => createRefreshToken(PRACTICE).value));
    expect(values.size).toBe(200);
  });

  it('stores only a hash, and the hash matches what parsing the cookie value yields', () => {
    const { value, hash } = createRefreshToken(PRACTICE);
    const parsed = parseRefreshToken(value);
    expect(parsed?.practiceId).toBe(PRACTICE);
    expect(parsed?.hash.equals(hash)).toBe(true);
    expect(hash.toString('utf8')).not.toContain(value.slice(-10));
  });

  it('binds the hash to the practice: editing the practice id makes an unknown token', () => {
    const { value, hash } = createRefreshToken(PRACTICE);
    const secret = value.split('.')[1];
    const tampered = parseRefreshToken(`${OTHER_PRACTICE}.${secret}`);
    expect(tampered?.hash.equals(hash)).toBe(false);
  });

  it('hashes deterministically', () => {
    expect(hashRefreshToken('abc').equals(hashRefreshToken('abc'))).toBe(true);
    expect(hashRefreshToken('abc').equals(hashRefreshToken('abd'))).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['a number', 12345],
    ['an object', { value: 'x' }],
    ['empty', ''],
    ['no separator', `${PRACTICE}${'A'.repeat(43)}`],
    ['secret too short', `${PRACTICE}.${'A'.repeat(42)}`],
    ['secret too long', `${PRACTICE}.${'A'.repeat(44)}`],
    ['secret with illegal characters', `${PRACTICE}.${'A'.repeat(42)}!`],
    ['practice id not a uuid', `not-a-uuid.${'A'.repeat(43)}`],
    ['uppercase practice id', `${PRACTICE.toUpperCase()}.${'A'.repeat(43)}`],
    ['sql injection attempt', `${PRACTICE}.'; drop table users; --`],
    ['trailing newline', `${PRACTICE}.${'A'.repeat(43)}\n`],
  ])('rejects a malformed value: %s', (_label, value) => {
    expect(parseRefreshToken(value)).toBeNull();
  });
});
