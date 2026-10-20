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
import { DocumentImportsModule } from '../document-imports/document-imports.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';
import { DocumentAgentService } from './document-agent.service.js';
import { DocumentAgentController } from './document-agent.controller.js';
import { AgentAuditService } from './agent-audit.service.js';
import { AgentMcpService } from './agent-mcp.service.js';
import { AgentSettingsService } from './agent-settings.service.js';

@Module({
  imports: [LlmModule, RetrievalModule, ObservabilityModule, DocumentsModule, MemoryModule,DocumentImportsModule,WorkspaceModule],
  controllers: [AiController,DocumentAgentController],
  providers: [
    DocumentAgentService,AgentAuditService,AgentMcpService,AgentSettingsService,
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
