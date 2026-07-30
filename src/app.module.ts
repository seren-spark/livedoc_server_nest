import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { LlmModule } from './ai/llm.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CoreConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { HealthController } from './health.controller.js';
import { IndexingModule } from './indexing/indexing.module.js';
import { ObservabilityController } from './observability/observability.controller.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { RetrievalModule } from './retrieval/retrieval.module.js';

@Module({
  imports: [
    CoreConfigModule,
    DatabaseModule,
    LlmModule,
    ObservabilityModule,
    AuthModule,
    RetrievalModule,
    IndexingModule,
    DocumentsModule,
    AiModule,
  ],
  controllers: [HealthController, ObservabilityController],
})
export class AppModule {}
