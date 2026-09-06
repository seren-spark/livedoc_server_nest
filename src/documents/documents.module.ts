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

@Module({
  imports: [forwardRef(() => IndexingModule), RetrievalModule, LlmModule, MemoryModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
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
