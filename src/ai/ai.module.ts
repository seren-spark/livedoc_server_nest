import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { AgentToolsService } from './agent-tools.service.js';
import { AiController } from './ai.controller.js';
import { AiWriterService } from './ai-writer.service.js';
import { DocumentSummaryService } from './document-summary.service.js';
import { LlmModule } from './llm.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { MemoryModule } from './memory.module.js';

@Module({
  imports: [LlmModule, RetrievalModule, ObservabilityModule, DocumentsModule, MemoryModule],
  controllers: [AiController],
  providers: [
    AgentToolsService,
    DocumentSummaryService,
    AiWriterService,
  ],
  exports: [
    AgentToolsService,
    DocumentSummaryService,
    AiWriterService,
  ],
})
export class AiModule {}
