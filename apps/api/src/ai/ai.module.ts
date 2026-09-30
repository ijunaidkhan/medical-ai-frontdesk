import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';

@Module({
  controllers: [AiController],
  providers: [AiService],
  // The agent (a later step) reads its configuration through this service.
  exports: [AiService],
})
export class AiModule {}
