/**
 * @file AI 业务模块。注册写作服务、文档 Agent、工具及相关控制器的依赖。
 */
import { AgentRuntimeService } from './agent-runtime.service.js';
import { AgentSupervisorService } from './agent-supervisor.service.js';
import { WikiModule } from '../wiki/wiki.module.js';
import { WikiController } from '../wiki/wiki.controller.js';
import { DocumentAgentToolsService } from './document-agent-tools.service.js';
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
import { AuthModule } from '../auth/auth.module.js';
import { AgentRunRepository } from './graph/agent-run.repository.js';
import { AgentGraphWorkflow } from './graph/agent-graph.workflow.js';
import { AgentGraphService } from './graph/agent-graph.service.js';
import { AgentGraphController } from './graph/agent-graph.controller.js';
import { WritingSkillsService } from './writing-skills.service.js';
import { WritingSkillsController } from './writing-skills.controller.js';
import { WritingPreferencesController } from './writing-preferences.controller.js';

@Module({
  imports: [AuthModule,WikiModule,LlmModule, RetrievalModule, ObservabilityModule, DocumentsModule, MemoryModule,DocumentImportsModule,WorkspaceModule],
  controllers: [WritingPreferencesController,WritingSkillsController,AgentGraphController,WikiController,AiController,DocumentAgentController],
  providers: [
    AgentRunRepository, AgentGraphWorkflow, AgentGraphService,
    WritingSkillsService,
    AgentSupervisorService,AgentRuntimeService,DocumentAgentToolsService,DocumentAgentService,AgentAuditService,AgentMcpService,AgentSettingsService,
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
