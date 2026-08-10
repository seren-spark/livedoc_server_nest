import { forwardRef, Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { AssetsService } from './assets.service.js';

@Module({
  imports: [forwardRef(() => IndexingModule), RetrievalModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, AssetsService],
  exports: [DocumentsService, AssetsService],
})
export class DocumentsModule {}
