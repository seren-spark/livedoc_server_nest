/**
 * @file Wiki 知识模块。组装知识编译、来源校验、存储和检索依赖。
 */
import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module.js";
import { RetrievalModule } from "../retrieval/retrieval.module.js";
import { LlmModule } from "../ai/llm.module.js";
import { WikiRepository } from "./wiki.repository.js";
import { WikiService } from "./wiki.service.js";
@Module({
  imports: [DocumentsModule, RetrievalModule, LlmModule],
  providers: [WikiRepository, WikiService],
  exports: [WikiService],
})
export class WikiModule {}
