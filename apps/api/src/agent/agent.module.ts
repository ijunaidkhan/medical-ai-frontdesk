import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModule } from '../ai/ai.module.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { AgentController, ConversationsController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { ConversationsService } from './conversations.service.js';
import { AnthropicModel } from './model/anthropic-model.js';
import { LANGUAGE_MODEL, UnconfiguredModel, type LanguageModel } from './model/language-model.js';
import { AgentTools } from './tools.js';

/** Chooses the language model from configuration. Without a configured provider there is no model: conversations cannot start (503). */
export function createLanguageModel(config: Pick<EnvironmentVariables, 'LLM_PROVIDER' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_MODEL'>): LanguageModel {
  if (config.LLM_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY) {
    return new AnthropicModel({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL });
  }
  return new UnconfiguredModel();
}

@Module({
  imports: [AiModule, KnowledgeModule, TasksModule],
  controllers: [AgentController, ConversationsController],
  providers: [
    AgentService,
    ConversationsService,
    AgentTools,
    {
      provide: LANGUAGE_MODEL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): LanguageModel =>
        createLanguageModel({
          LLM_PROVIDER: config.get('LLM_PROVIDER', { infer: true }),
          ANTHROPIC_API_KEY: config.get('ANTHROPIC_API_KEY', { infer: true }),
          ANTHROPIC_MODEL: config.get('ANTHROPIC_MODEL', { infer: true }),
        }),
    },
  ],
})
export class AgentModule {}
