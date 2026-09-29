import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { AccessTokenService } from './access-token.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OriginGuard } from './origin.guard.js';
import { PasswordHasher } from './password-hasher.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordHasher,
    OriginGuard,
    {
      provide: AccessTokenService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        new AccessTokenService(config.get('ACCESS_TOKEN_SECRET', { infer: true })),
    },
  ],
  // The global AccessTokenGuard (registered in AppModule) needs the token service.
  exports: [AccessTokenService, PasswordHasher],
})
export class AuthModule {}
