import { validateEnv } from './env.validation.js';

const DATABASE_URL = 'postgres://frontdesk_app:placeholder@localhost:5432/frontdesk';
const ACCESS_TOKEN_SECRET = 'unit-test-signing-key-0123456789abcdef';
const REQUIRED = { DATABASE_URL, ACCESS_TOKEN_SECRET };

describe('validateEnv', () => {
  it('applies safe defaults when only the required variables are set', () => {
    const env = validateEnv(REQUIRED);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
  });

  it('parses PORT as a number and CORS_ORIGINS as a trimmed list', () => {
    const env = validateEnv({
      ...REQUIRED,
      PORT: '8080',
      CORS_ORIGINS: 'http://localhost:4200, https://app.example.com',
    });
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:4200', 'https://app.example.com']);
  });

  it('requires DATABASE_URL', () => {
    expect(() => validateEnv({ ACCESS_TOKEN_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not a postgres URL, without echoing it', () => {
    const bad = 'mysql://user:topsecret@localhost/db';
    expect(() => validateEnv({ ...REQUIRED, DATABASE_URL: bad })).toThrow(/DATABASE_URL/);
    try {
      validateEnv({ ...REQUIRED, DATABASE_URL: bad });
    } catch (error) {
      expect((error as Error).message).not.toContain('topsecret');
    }
  });

  describe('ACCESS_TOKEN_SECRET', () => {
    it('is required', () => {
      expect(() => validateEnv({ DATABASE_URL })).toThrow(/ACCESS_TOKEN_SECRET/);
    });

    it('is refused when blank (as in an unedited .env.example)', () => {
      expect(() => validateEnv({ DATABASE_URL, ACCESS_TOKEN_SECRET: '' })).toThrow(/ACCESS_TOKEN_SECRET/);
    });

    it('is refused when shorter than 32 characters, without echoing it', () => {
      const weak = 'too-short-secret';
      expect(() => validateEnv({ DATABASE_URL, ACCESS_TOKEN_SECRET: weak })).toThrow(/ACCESS_TOKEN_SECRET/);
      try {
        validateEnv({ DATABASE_URL, ACCESS_TOKEN_SECRET: weak });
      } catch (error) {
        expect((error as Error).message).not.toContain(weak);
      }
    });
  });

  describe('TRUST_PROXY_HOPS', () => {
    it('accepts a small whole number', () => {
      expect(validateEnv({ ...REQUIRED, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
    });

    it.each(['-1', '6', '1.5', 'many'])('rejects %s', (value) => {
      expect(() => validateEnv({ ...REQUIRED, TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
    });
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ ...REQUIRED, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => validateEnv({ ...REQUIRED, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...REQUIRED, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects a CORS origin without a protocol', () => {
    expect(() => validateEnv({ ...REQUIRED, CORS_ORIGINS: 'localhost:4200' })).toThrow(/CORS_ORIGINS/);
  });

  it('never includes the offending value in the error message', () => {
    expect(() => validateEnv({ ...REQUIRED, LOG_LEVEL: 'super-secret-value' })).toThrow(/LOG_LEVEL/);
    try {
      validateEnv({ ...REQUIRED, LOG_LEVEL: 'super-secret-value' });
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-value');
    }
  });

  it('drops unrelated environment variables from the validated config', () => {
    const env = validateEnv({ ...REQUIRED, SOME_OTHER_VAR: 'x' }) as unknown as Record<string, unknown>;
    expect(env['SOME_OTHER_VAR']).toBeUndefined();
  });
});
