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

  describe('the language model', () => {
    const KEY = 'sk-test-0123456789-abcdefghijklmnopqrstuvwxyz';

    it('is off by default: no provider, the default model name, no key needed', () => {
      const env = validateEnv(REQUIRED);
      expect(env.LLM_PROVIDER).toBe('none');
      expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('treats blank values (an unedited .env) as not set', () => {
      const env = validateEnv({ ...REQUIRED, LLM_PROVIDER: '', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' });
      expect(env).toMatchObject({ LLM_PROVIDER: 'none', ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('accepts the Anthropic provider with a key and a chosen model', () => {
      const env = validateEnv({ ...REQUIRED, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001' });
      expect(env).toMatchObject({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001' });
    });

    it.each([
      ['no key', {}],
      ['a blank key', { ANTHROPIC_API_KEY: '' }],
      ['a key that is obviously too short', { ANTHROPIC_API_KEY: 'abc' }],
    ])('refuses the Anthropic provider with %s', (_name, extra) => {
      expect(() => validateEnv({ ...REQUIRED, LLM_PROVIDER: 'anthropic', ...extra })).toThrow(/ANTHROPIC_API_KEY/);
    });

    it('does not insist on a key when no provider is chosen', () => {
      expect(() => validateEnv({ ...REQUIRED, LLM_PROVIDER: 'none' })).not.toThrow();
    });

    it('refuses an unknown provider and a model id with odd characters', () => {
      expect(() => validateEnv({ ...REQUIRED, LLM_PROVIDER: 'openai' })).toThrow(/LLM_PROVIDER/);
      expect(() => validateEnv({ ...REQUIRED, ANTHROPIC_MODEL: 'claude sonnet; drop table' })).toThrow(/ANTHROPIC_MODEL/);
    });

    it('never echoes the key in an error message', () => {
      try {
        validateEnv({ ...REQUIRED, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'bad model!' });
        throw new Error('should have been refused');
      } catch (error) {
        expect((error as Error).message).toMatch(/ANTHROPIC_MODEL/);
        expect((error as Error).message).not.toContain(KEY);
      }
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
