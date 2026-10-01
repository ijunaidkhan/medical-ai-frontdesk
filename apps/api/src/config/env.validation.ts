import { plainToInstance, Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength, validateSync, ValidateIf } from 'class-validator';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LLM_PROVIDERS = ['none', 'anthropic', 'ollama'] as const;
export const VOICE_PROVIDERS = ['none', 'twilio'] as const;
export const VOICE_TTS_PROVIDERS = ['Google', 'Amazon', 'ElevenLabs'] as const;
export const VOICE_STT_PROVIDERS = ['Google', 'Deepgram'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Every environment variable the API reads. Add new variables here so a
 * misconfigured deployment fails at startup instead of at first use.
 */
export class EnvironmentVariables {
  @IsIn(NODE_ENVS)
  NODE_ENV: (typeof NODE_ENVS)[number] = 'development';

  @Transform(({ value }) => (value === undefined || value === '' ? 3000 : Number(value)))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info';

  /**
   * Comma-separated list of browser origins allowed to call the API
   * (e.g. "http://localhost:4200"). Empty means no cross-origin access.
   */
  /**
   * Connection string for the API's runtime database role (frontdesk_app),
   * which is subject to row-level security. Contains a password: never log it.
   */
  @IsUrl(
    { protocols: ['postgres', 'postgresql'], require_tld: false, require_protocol: true },
    { message: 'DATABASE_URL must be a postgres:// or postgresql:// connection URL' },
  )
  DATABASE_URL!: string;

  /**
   * Key used to sign access tokens (HS256). At least 32 characters of random
   * data; generate with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   * Rotating it signs every user out. Never log it or commit it.
   */
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  ACCESS_TOKEN_SECRET!: string;

  /**
   * How many reverse proxies / load balancers sit in front of the API (0 = none).
   * The client IP for rate limiting and audit logs is read from X-Forwarded-For
   * only when this is above 0. Too low: everyone shares the balancer's IP.
   * Too high: clients can spoof their IP and dodge rate limits.
   */
  @Transform(({ value }) => (value === undefined || value === '' ? 0 : Number(value)))
  @IsInt()
  @Min(0)
  @Max(5)
  TRUST_PROXY_HOPS: number = 0;

  /**
   * Which language model answers callers. "none" (the default) means no model:
   * test chats cannot start, but the fixed emergency scripts still work.
   */
  @Transform(({ value }) => (value === undefined || value === '' ? 'none' : value))
  @IsIn(LLM_PROVIDERS)
  LLM_PROVIDER: (typeof LLM_PROVIDERS)[number] = 'none';

  /**
   * Anthropic API key. Required only when LLM_PROVIDER=anthropic. A secret: it is
   * read from the environment only, never logged, never returned by the API, never committed.
   */
  @Transform(({ value }) => (value === '' ? undefined : value))
  @ValidateIf((config: EnvironmentVariables) => config.LLM_PROVIDER === 'anthropic')
  @IsString()
  @MinLength(20, { message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic' })
  @MaxLength(512)
  ANTHROPIC_API_KEY?: string;

  /** The Anthropic model id, e.g. claude-sonnet-5-5 (more capable) or claude-haiku-4-5-20251001 (faster, cheaper). */
  @Transform(({ value }) => (value === undefined || value === '' ? 'claude-sonnet-5-5' : value))
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,100}$/, { message: 'ANTHROPIC_MODEL must be a model id such as claude-sonnet-5-5' })
  ANTHROPIC_MODEL: string = 'claude-sonnet-5-5';

  /**
   * Ollama, a free program that runs language models on your own computer (used when
   * LLM_PROVIDER=ollama). Nothing leaves the machine and no key is needed. The model must
   * support tools, e.g. llama3.1:8b, llama3.2:3b or qwen2.5:7b (install with: ollama pull <name>).
   */
  @Transform(({ value }) => (value === undefined || value === '' ? 'http://localhost:11434' : typeof value === 'string' ? value.replace(/\/+$/, '') : value))
  @IsUrl({ protocols: ['http', 'https'], require_tld: false, require_protocol: true }, { message: 'OLLAMA_BASE_URL must be an http(s) address such as http://localhost:11434' })
  OLLAMA_BASE_URL: string = 'http://localhost:11434';

  @Transform(({ value }) => (value === undefined || value === '' ? 'llama3.1:8b' : value))
  @IsString()
  @Matches(/^[A-Za-z0-9._:/-]{1,100}$/, { message: 'OLLAMA_MODEL must be a model name such as llama3.1:8b' })
  OLLAMA_MODEL: string = 'llama3.1:8b';

  /** A model on a laptop is slow, especially for the first reply (it has to load). */
  @Transform(({ value }) => (value === undefined || value === '' ? 90 : Number(value)))
  @IsInt()
  @Min(5)
  @Max(600)
  OLLAMA_TIMEOUT_SECONDS: number = 90;

  /**
   * Whether the API answers phone calls. "none" (the default) keeps every /api/voice
   * route switched off (404); "twilio" needs the two settings below.
   */
  @Transform(({ value }) => (value === undefined || value === '' ? 'none' : value))
  @IsIn(VOICE_PROVIDERS)
  VOICE_PROVIDER: (typeof VOICE_PROVIDERS)[number] = 'none';

  /**
   * Twilio's auth token, used ONLY to check that a request really came from Twilio
   * (its signature). A secret: environment only, never logged, never returned, never committed.
   */
  @Transform(({ value }) => (value === '' ? undefined : value))
  @ValidateIf((config: EnvironmentVariables) => config.VOICE_PROVIDER === 'twilio')
  @IsString()
  @MinLength(20, { message: 'TWILIO_AUTH_TOKEN is required when VOICE_PROVIDER=twilio' })
  @MaxLength(256)
  TWILIO_AUTH_TOKEN?: string;

  /**
   * The public address Twilio uses to reach this API (for example the https address of
   * your tunnel or load balancer), without a trailing slash. Twilio signs the exact
   * address it called, so the check must be built from this setting and never from
   * anything in the request. Required when VOICE_PROVIDER=twilio.
   */
  @Transform(({ value }) => (value === '' ? undefined : typeof value === 'string' ? value.replace(/\/+$/, '') : value))
  @ValidateIf((config: EnvironmentVariables) => config.VOICE_PROVIDER === 'twilio')
  @IsUrl({ protocols: ['http', 'https'], require_tld: false, require_protocol: true }, { message: 'PUBLIC_BASE_URL must be the public http(s) address of this API' })
  @Matches(/^[^?#]*$/, { message: 'PUBLIC_BASE_URL must not contain a query string or fragment' })
  PUBLIC_BASE_URL?: string;

  /**
   * Which engine speaks to callers, and which one listens, inside Twilio's ConversationRelay.
   * Optional: when unset, Twilio's own defaults apply. Set them explicitly once you have
   * confirmed which engines your agreements (for example Twilio's HIPAA addendum) cover.
   */
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsIn(VOICE_TTS_PROVIDERS)
  VOICE_TTS_PROVIDER?: (typeof VOICE_TTS_PROVIDERS)[number];

  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsIn(VOICE_STT_PROVIDERS)
  VOICE_STT_PROVIDER?: (typeof VOICE_STT_PROVIDERS)[number];

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0)
      : value,
  )
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] }, { each: true })
  CORS_ORIGINS: string[] = [];
}

/**
 * Used by ConfigModule. Error messages name the offending variable but never
 * include its value, because future variables will hold secrets.
 */
export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, { exposeDefaultValues: true });
  const errors = validateSync(config, { skipMissingProperties: false, whitelist: true });

  if (errors.length > 0) {
    const problems = errors.map(
      (error) => `${error.property}: ${Object.values(error.constraints ?? {}).join('; ')}`,
    );
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }

  return config;
}
