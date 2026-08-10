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
import { StorageModule } from './storage/storage.module.js';
import { DocumentImportsModule } from './document-imports/document-imports.module.js';

@Module({
  imports: [
    CoreConfigModule,
    DatabaseModule,
    StorageModule,
    LlmModule,
    ObservabilityModule,
    AuthModule,
    RetrievalModule,
    IndexingModule,
    DocumentsModule,
    DocumentImportsModule,
    AiModule,
  ],
  controllers: [HealthController, ObservabilityController],
})
export class AppModule {}
