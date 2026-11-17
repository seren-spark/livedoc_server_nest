/**
 * @file 本地推理模块。注册推理线程、文本向量和重排服务。
 */
import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service.js';
import { InferenceWorkerService } from './inference-worker.service.js';
import { RerankerService } from './reranker.service.js';

@Module({
  providers: [InferenceWorkerService, EmbeddingService, RerankerService],
  exports: [EmbeddingService, RerankerService],
})
export class InferenceModule {}
