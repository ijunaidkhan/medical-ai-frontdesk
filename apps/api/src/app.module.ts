import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
    LoggingModule,
    CommonModule,
    DatabaseModule,
    HealthModule,
  ],
})
export class AppModule {}
