/**
 * @file 索引模块。注册索引队列和 Worker，连接文档、向量库与资源服务。
 */
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
