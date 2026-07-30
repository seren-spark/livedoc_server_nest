import { forwardRef, Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({
  imports: [forwardRef(() => IndexingModule), RetrievalModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
