import { plainToInstance, Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength, validateSync, ValidateIf } from 'class-validator';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LLM_PROVIDERS = ['none', 'anthropic'] as const;
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
