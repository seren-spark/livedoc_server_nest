import { forwardRef, Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module.js";
import { IndexingModule } from "../indexing/indexing.module.js";
import { RetrievalModule } from "../retrieval/retrieval.module.js";
import { WorkspaceService } from "./workspace.service.js";
import { WorkspaceController } from "./workspace.controller.js";
import { MemoryModule } from "../ai/memory.module.js";
import { DocumentImportsModule } from '../document-imports/document-imports.module.js';
@Module({
  imports: [
    forwardRef(() => DocumentsModule),
    IndexingModule,
    RetrievalModule,
    MemoryModule,
    forwardRef(()=>DocumentImportsModule),
  ],
  providers: [WorkspaceService],
  controllers: [WorkspaceController],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
