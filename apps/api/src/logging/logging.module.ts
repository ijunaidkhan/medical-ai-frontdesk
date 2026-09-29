import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { EnvironmentVariables } from '../config/env.validation.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept a caller-supplied request ID only if it cannot be used for log injection. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function resolveRequestId(incoming: string | string[] | undefined): string {
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Paths whose values must never reach the logs. The request serializer below
 * already logs only method and path; this is a second line of defence for
 * anything logged manually (for example an object that contains a password).
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
            res.setHeader(REQUEST_ID_HEADER, id);
            return id;
          },
          // Health probes fire every few seconds; logging them only adds noise.
          autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/api/health') ?? false },
          // Whitelist what we log. Never include headers, query strings or bodies,
          // since later milestones will carry patient data in them.
          serializers: {
            req: (req: { id?: string; method?: string; url?: string }) => ({
              id: req.id,
              method: req.method,
              path: req.url?.split('?')[0],
            }),
            res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
