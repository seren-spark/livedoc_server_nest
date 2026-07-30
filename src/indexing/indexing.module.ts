import { forwardRef, Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { IndexingController } from './indexing.controller.js';
import { IndexJobsService } from './index-jobs.service.js';
import { IndexWorkerService } from './index-worker.service.js';

@Module({
  imports: [forwardRef(() => DocumentsModule), RetrievalModule],
  controllers: [IndexingController],
  providers: [IndexJobsService, IndexWorkerService],
  exports: [IndexJobsService, IndexWorkerService],
})
export class IndexingModule {}
