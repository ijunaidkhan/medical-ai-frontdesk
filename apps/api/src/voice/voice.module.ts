import { Module } from '@nestjs/common';
import { PhoneNumbersController } from './phone-numbers.controller.js';
import { PhoneNumbersService } from './phone-numbers.service.js';
import { TwilioSignatureGuard } from './twilio-signature.guard.js';

/** Phone calls. The call endpoints arrive in the next steps; this holds the parts they all rely on. */
@Module({
  controllers: [PhoneNumbersController],
  providers: [PhoneNumbersService, TwilioSignatureGuard],
  exports: [PhoneNumbersService, TwilioSignatureGuard],
})
export class VoiceModule {}
