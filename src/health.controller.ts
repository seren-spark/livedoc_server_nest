import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator.js';
import { AppConfig } from './config/app-config.js';

@Controller()
export class HealthController {
  constructor(private readonly config: AppConfig) {}

  @Public()
  @Get('health')
  health() {
    const invalid = this.config.realMisconfigurations();
    return {
      status: invalid.length === 0 ? 'ok' : 'degraded',
      production_ready: invalid.length === 0,
      production_misconfigurations: invalid,
      app_env: this.config.appEnv,
      runtime_mode: this.config.runtimeMode,
      env_file: this.config.envFile,
      allowed_origins: this.config.allowedOrigins,
      metadata_store: this.config.metadataStore,
      vector_store: this.config.vectorStore,
      embedding_provider: this.config.embeddingProvider,
      embedding_dim: this.config.embeddingDim,
      chunk_max_tokens: this.config.chunkMaxTokens,
      chunk_overlap_tokens: this.config.chunkOverlapTokens,
      sparse_embedding_provider: this.config.sparseEmbeddingProvider,
      rerank_provider: this.config.rerankProvider,
      agent_tool_selection: this.config.agentToolSelection,
      query_expansion_enabled: this.config.queryExpansionEnabled,
      query_expansion_max_variants: this.config.queryExpansionMaxVariants,
      memory_store: this.config.memoryStore,
      index_job_store: this.config.indexJobStore,
      import_job_store: this.config.importJobStore,
      storage_provider: this.config.storageProvider,
      import_max_upload_mb: this.config.importMaxUploadMb,
      import_retention_days: this.config.importRetentionDays,
      vision_configured: Boolean(
        this.config.visionApiBaseUrl && this.config.visionApiKey && this.config.visionModel,
      ),
      observability_store: this.config.observabilityStore,
      llm_provider: this.config.llmProvider,
      llm_model: this.config.llmModel,
      llm_configured: Boolean(this.config.llmApiKey),
      collection: this.config.qdrantCollection,
      config_fingerprint: this.config.configFingerprint,
    };
  }

  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('health/ready')
  ready() {
    const missing = this.config.realMisconfigurations();
    return {
      status: missing.length ? 'not_ready' : 'ready',
      missing,
      runtime_mode: this.config.runtimeMode,
      env_file: this.config.envFile,
      config_fingerprint: this.config.configFingerprint,
    };
  }
}
