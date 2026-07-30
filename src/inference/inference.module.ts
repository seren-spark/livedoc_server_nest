import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service.js';
import { InferenceWorkerService } from './inference-worker.service.js';
import { RerankerService } from './reranker.service.js';

@Module({
  providers: [InferenceWorkerService, EmbeddingService, RerankerService],
  exports: [EmbeddingService, RerankerService],
})
export class InferenceModule {}
