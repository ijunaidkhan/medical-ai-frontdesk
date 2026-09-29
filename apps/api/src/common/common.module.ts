import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

@Module({
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    {
      // Reject unknown properties instead of silently ignoring them, so clients
      // cannot smuggle in fields (mass assignment) that a DTO does not declare.
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class CommonModule {}
