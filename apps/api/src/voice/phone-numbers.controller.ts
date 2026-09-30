import { Controller, Get } from '@nestjs/common';
import type { PhoneNumberSummary } from '@frontdesk/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { PhoneNumbersService } from './phone-numbers.service.js';

/** The phone numbers connected to the signed-in practice. Read-only: the operator adds and switches numbers. */
@Controller('ai/phone-numbers')
export class PhoneNumbersController {
  constructor(private readonly numbers: PhoneNumbersService) {}

  @RequirePermissions('ai:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<PhoneNumberSummary[]> {
    return this.numbers.listForPractice(auth);
  }
}
