import { validateEnv } from './env.validation.js';

const DATABASE_URL = 'postgres://frontdesk_app:placeholder@localhost:5432/frontdesk';

describe('validateEnv', () => {
  it('applies safe defaults when only the required variables are set', () => {
    const env = validateEnv({ DATABASE_URL });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
  });

  it('parses PORT as a number and CORS_ORIGINS as a trimmed list', () => {
    const env = validateEnv({
      DATABASE_URL,
      PORT: '8080',
      CORS_ORIGINS: 'http://localhost:4200, https://app.example.com',
    });
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:4200', 'https://app.example.com']);
  });

  it('requires DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not a postgres URL, without echoing it', () => {
    const bad = 'mysql://user:topsecret@localhost/db';
    expect(() => validateEnv({ DATABASE_URL: bad })).toThrow(/DATABASE_URL/);
    try {
      validateEnv({ DATABASE_URL: bad });
    } catch (error) {
      expect((error as Error).message).not.toContain('topsecret');
    }
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ DATABASE_URL, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => validateEnv({ DATABASE_URL, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ DATABASE_URL, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects a CORS origin without a protocol', () => {
    expect(() => validateEnv({ DATABASE_URL, CORS_ORIGINS: 'localhost:4200' })).toThrow(/CORS_ORIGINS/);
  });

  it('never includes the offending value in the error message', () => {
    expect(() => validateEnv({ DATABASE_URL, LOG_LEVEL: 'super-secret-value' })).toThrow(/LOG_LEVEL/);
    try {
      validateEnv({ DATABASE_URL, LOG_LEVEL: 'super-secret-value' });
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-value');
    }
  });

  it('drops unrelated environment variables from the validated config', () => {
    const env = validateEnv({ DATABASE_URL, SOME_OTHER_VAR: 'x' }) as unknown as Record<string, unknown>;
    expect(env['SOME_OTHER_VAR']).toBeUndefined();
  });
});
