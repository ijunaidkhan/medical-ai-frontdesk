import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { AiModule } from '../ai/ai.module.js';
import { PhoneNumbersController } from './phone-numbers.controller.js';
import { PhoneNumbersService } from './phone-numbers.service.js';
import { RelayGateway } from './relay.gateway.js';
import { TwilioSignatureGuard } from './twilio-signature.guard.js';
import { VoiceController } from './voice.controller.js';
import { VoiceService } from './voice.service.js';

/** Phone calls: which practice a call is for, whether the AI answers, and the live voice session. */
@Module({
  imports: [AiModule, AgentModule],
  controllers: [PhoneNumbersController, VoiceController],
  providers: [PhoneNumbersService, TwilioSignatureGuard, VoiceService, RelayGateway],
  exports: [PhoneNumbersService, TwilioSignatureGuard],
})
export class VoiceModule {}
