import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { AgentController, ConversationsController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { ConversationsService } from './conversations.service.js';
import { LANGUAGE_MODEL, UnconfiguredModel } from './model/language-model.js';
import { AgentTools } from './tools.js';

@Module({
  imports: [AiModule, KnowledgeModule, TasksModule],
  controllers: [AgentController, ConversationsController],
  providers: [
    AgentService,
    ConversationsService,
    AgentTools,
    // No vendor is chosen yet. Until one is configured, conversations cannot start (503);
    // tests replace this with a scripted model.
    { provide: LANGUAGE_MODEL, useClass: UnconfiguredModel },
  ],
})
export class AgentModule {}
