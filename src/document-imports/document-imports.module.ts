/**
 * @file 文档导入模块。组装导入任务、解析器、视觉分析和资源依赖。
 */
import { MemoryModule } from '../ai/memory.module.js';
import { forwardRef, Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { IndexingModule } from '../indexing/indexing.module.js';
import { DoclingParserService } from './docling-parser.service.js';
import { DocumentImportsController } from './document-imports.controller.js';
import { DocumentImportsService } from './document-imports.service.js';
import { ImportWorkerService } from './import-worker.service.js';
import { VisionService } from './vision.service.js';
import { AssetsController } from '../documents/assets/assets.controller.js';

@Module({
  imports: [forwardRef(()=>DocumentsModule), IndexingModule, MemoryModule],
  controllers: [DocumentImportsController, AssetsController],
  providers: [DocumentImportsService, DoclingParserService, VisionService, ImportWorkerService],
  exports: [DocumentImportsService, ImportWorkerService],
})
export class DocumentImportsModule {}
