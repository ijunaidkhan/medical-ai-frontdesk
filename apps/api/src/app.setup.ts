import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { EnvironmentVariables } from './config/env.validation.js';

/**
 * Application-level setup shared by main.ts and the e2e tests, so tests run
 * against the same security configuration as production.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({
    // An explicit allowlist. An empty list disables cross-origin access entirely.
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
  });
  app.enableShutdownHooks();
}
