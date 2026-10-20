import { forwardRef, Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { AssetsService } from './assets/assets.service.js';
import { LlmModule } from '../ai/llm.module.js';
import { DocumentMemoryJobsService } from './document-memory/document-memory-jobs.service.js';
import { DocumentMemoryService } from './document-memory/document-memory.service.js';
import { DocumentMemoryWorkerService } from './document-memory/document-memory-worker.service.js';
import { MemoryModule } from '../ai/memory.module.js';
import { ArticlesController } from '../articles/articles.controller.js';
import { ArticlesService } from '../articles/articles.service.js';
import { ArticleInteractionsService } from '../articles/article-interactions.service.js';
import { ArticleInteractionsController } from '../articles/article-interactions.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';

@Module({
  imports: [forwardRef(() => IndexingModule), forwardRef(() => RetrievalModule), forwardRef(() => WorkspaceModule), LlmModule, MemoryModule, AuthModule],
  controllers: [DocumentsController, ArticlesController, ArticleInteractionsController],
  providers: [
    DocumentsService,
    ArticlesService,
    ArticleInteractionsService,
    AssetsService,
    DocumentMemoryService,
    DocumentMemoryJobsService,
    DocumentMemoryWorkerService,
  ],
  exports: [
    DocumentsService,
    AssetsService,
    DocumentMemoryService,
    DocumentMemoryJobsService,
    DocumentMemoryWorkerService,
  ],
})
export class DocumentsModule {}
