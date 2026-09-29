import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { EnvironmentVariables } from './config/env.validation.js';

/**
 * Application-level setup shared by main.ts and the e2e/integration tests, so
 * tests run against the same security configuration as production.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');

  // Client IP for rate limiting and audit logs; see TRUST_PROXY_HOPS in env.validation.ts.
  app.getHttpAdapter().getInstance().set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  app.use(helmet());
  // Responses will carry personal data in later milestones: never let browsers or proxies cache them.
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cookieParser());
  app.enableCors({
    // An explicit allowlist. An empty list disables cross-origin access entirely.
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
  });
  app.enableShutdownHooks();
}
