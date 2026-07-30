import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { AgentToolsService } from './agent-tools.service.js';
import { AiController } from './ai.controller.js';
import { AiWriterService } from './ai-writer.service.js';
import { LlmModule } from './llm.module.js';
import { ConversationMemoryService } from './memory.service.js';

@Module({
  imports: [LlmModule, RetrievalModule, ObservabilityModule],
  controllers: [AiController],
  providers: [AgentToolsService, ConversationMemoryService, AiWriterService],
  exports: [AgentToolsService, ConversationMemoryService, AiWriterService],
})
export class AiModule {}
