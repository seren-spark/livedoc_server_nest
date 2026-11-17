/**
 * @file 服务健康接口。区分进程存活与依赖就绪状态，供启动检查和监控使用。
 */
import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator.js';
import { AppConfig } from './config/app-config.js';

@Controller()
export class HealthController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * 返回服务整体健康状态及依赖概况。
   *
   * @returns 整理后的状态与操作结果对象。
   */
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
      embedding_model: this.config.embeddingModel,
      rerank_model: this.config.rerankModel,
      rerank_top_n: this.config.rerankTopN,
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

  /**
   * 检查当前 API 进程是否仍在运行。
   *
   * @returns 整理后的状态与操作结果对象。
   */
  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /**
   * 检查必要依赖是否已准备好接收业务请求。
   *
   * @returns 整理后的状态与操作结果对象。
   */
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
