/**
 * @file 检索模块。组装分块、稀疏与稠密向量、重排、压缩及向量存储依赖。
 */
import { Module } from '@nestjs/common';
import { InferenceModule } from '../inference/inference.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { LlmModule } from '../ai/llm.module.js';
import { ContextCompressorService } from './context-compressor.service.js';
import { RetrievalController } from './retrieval.controller.js';
import { RetrievalService } from './retrieval.service.js';
import { SparseEmbeddingService } from './sparse-embedding.service.js';
import { VectorStoreService } from './vector-store.service.js';

@Module({
  imports: [InferenceModule, ObservabilityModule, LlmModule],
  controllers: [RetrievalController],
  providers: [SparseEmbeddingService, ContextCompressorService, VectorStoreService, RetrievalService],
  exports: [SparseEmbeddingService, ContextCompressorService, VectorStoreService, RetrievalService],
})
export class RetrievalModule {}
