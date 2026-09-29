import { plainToInstance, Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUrl, Max, Min, validateSync } from 'class-validator';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
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
