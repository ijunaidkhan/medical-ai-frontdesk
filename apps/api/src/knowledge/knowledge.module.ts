import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { KnowledgeRetriever } from './retriever.js';

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeRetriever],
  // The agent (a later step) reads knowledge only through the retriever.
  exports: [KnowledgeRetriever],
})
export class KnowledgeModule {}
