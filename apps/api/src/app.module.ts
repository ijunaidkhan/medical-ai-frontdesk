import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccessTokenGuard } from './auth/access-token.guard.js';
import { DEFAULT_RATE_LIMIT } from './auth/auth.constants.js';
import { AuthModule } from './auth/auth.module.js';
import { CommonModule } from './common/common.module.js';
import { validateEnv } from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { LoggingModule } from './logging/logging.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Real environment variables always win over the file. Tests use only
      // explicit variables so a developer's local .env cannot change results.
      ignoreEnvFile: process.env['NODE_ENV'] === 'test',
      envFilePath: ['.env', '../../.env'],
    }),
    // Per-IP request limit for every route; login and refresh set stricter ones.
    // Counters live in this process's memory: with several API instances behind a
    // load balancer, move them to a shared store (e.g. Redis) before relying on the limits.
    ThrottlerModule.forRoot([{ name: 'default', ...DEFAULT_RATE_LIMIT }]),
    LoggingModule,
    CommonModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
  ],
  providers: [
    // Guards run in the order they are listed: rate limit first, then authentication.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
})
export class AppModule {}
