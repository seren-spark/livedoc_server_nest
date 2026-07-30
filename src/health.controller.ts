import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator.js';
import { AppConfig } from './config/app-config.js';

@Controller()
export class HealthController {
  constructor(private readonly config: AppConfig) {}

  @Public()
  @Get('health')
  health() {
    const invalid = this.config.productionMisconfigurations();
    return {
      status: 'ok',
      production_ready: invalid.length === 0,
      production_misconfigurations: invalid,
      app_env: this.config.appEnv,
      allowed_origins: this.config.allowedOrigins,
      metadata_store: this.config.metadataStore,
      vector_store: this.config.vectorStore,
      embedding_provider: this.config.embeddingProvider,
      embedding_dim: this.config.embeddingDim,
      sparse_embedding_provider: this.config.sparseEmbeddingProvider,
      rerank_provider: this.config.rerankProvider,
      agent_tool_selection: this.config.agentToolSelection,
      query_expansion_enabled: this.config.queryExpansionEnabled,
      query_expansion_max_variants: this.config.queryExpansionMaxVariants,
      memory_store: this.config.memoryStore,
      index_job_store: this.config.indexJobStore,
      observability_store: this.config.observabilityStore,
      llm_provider: this.config.llmProvider,
      llm_model: this.config.llmModel,
      llm_configured: Boolean(this.config.llmApiKey),
      collection: this.config.qdrantCollection,
    };
  }
}
