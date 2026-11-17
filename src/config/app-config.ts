/**
 * @file 应用运行配置。读取环境变量，校验模型和存储配置，并生成可观测的配置摘要。
 */
import { Injectable } from '@nestjs/common';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ModelRouter } from '../ai/model-routing.js';

const configDir = dirname(fileURLToPath(import.meta.url));
/**
 * 寻找配置文件所在的项目根目录。
 *
 * @param start 区间起始位置。
 * @returns 整理后的文本或标识。
 */
function findProjectRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(resolve(current, 'package.json')) && existsSync(resolve(current, 'src'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Cannot resolve livedoc_server_nest project root from ${start}`);
}
const projectRoot = findProjectRoot(configDir);
const envFile = process.env.ENV_FILE
  ? resolve(projectRoot, process.env.ENV_FILE)
  : resolve(projectRoot, '.env');
if (process.env.NODE_ENV !== 'test') loadDotenv({ path: envFile, override: false });

/**
 * 将环境变量转换为布尔开关并应用默认值。
 *
 * @param name 目标名称。
 * @param fallback 首选路径不可用时采用的回退值。
 * @returns 条件是否满足的判断结果。
 */
function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * 将逗号分隔的环境变量转换为字符串列表。
 *
 * @param name 目标名称。
 * @param fallback 首选路径不可用时采用的回退值。
 * @returns 整理后的字符串列表。
 */
function csvEnv(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 解析对象形式的 JSON 环境变量。
 *
 * @param name 目标名称。
 * @returns Record<string, unknown> 类型的处理结果。
 */
function jsonObjectEnv(name: string): Record<string, unknown> {
  const raw = process.env[name]?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${name} must contain a valid JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

@Injectable()
export class AppConfig {
  readonly projectRoot = projectRoot;
  readonly envFile = envFile;
  readonly appEnv = process.env.APP_ENV ?? 'development';
  readonly runtimeMode = process.env.RAG_RUNTIME_MODE ?? (process.env.NODE_ENV === 'test' ? 'test' : 'real');
  readonly host = process.env.APP_HOST ?? '127.0.0.1';
  readonly port = Number(process.env.APP_PORT ?? 8001);
  readonly allowedOrigins = csvEnv(
    'ALLOWED_ORIGINS',
    this.appEnv === 'production'
      ? ''
      : 'http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173,http://localhost:3000,http://127.0.0.1:3000',
  );
  readonly metadataStore = process.env.METADATA_STORE ?? 'memory';
  readonly databaseUrl = process.env.DATABASE_URL ?? '';
  readonly vectorStore = process.env.VECTOR_STORE ?? (this.runtimeMode === 'test' ? 'memory' : 'qdrant');
  readonly qdrantUrl = process.env.QDRANT_URL ?? 'http://127.0.0.1:6335';
  readonly qdrantApiKey = process.env.QDRANT_API_KEY ?? '';
  readonly qdrantCollection =
    process.env.QDRANT_COLLECTION ?? 'article_chunks_nest_v1';
  readonly embeddingProvider = process.env.EMBEDDING_PROVIDER ?? (this.runtimeMode === 'test' ? 'hash' : 'transformers');
  readonly embeddingModel =
    process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-zh-v1.5';
  readonly embeddingDim = Number(process.env.EMBEDDING_DIM ?? 512);
  readonly chunkMaxTokens = Number(process.env.CHUNK_MAX_TOKENS ?? 420);
  readonly chunkOverlapTokens = Number(process.env.CHUNK_OVERLAP_TOKENS ?? 64);
  readonly sparseEmbeddingProvider =
    process.env.SPARSE_EMBEDDING_PROVIDER ?? (this.runtimeMode === 'test' ? 'memory_bm25' : 'qdrant_idf');
  readonly sparseEmbeddingModel = process.env.SPARSE_EMBEDDING_MODEL ?? 'Qdrant/bm25';
  readonly rerankProvider = process.env.RERANK_PROVIDER ?? (this.runtimeMode === 'test' ? 'heuristic' : 'bge');
  readonly rerankModel =
    process.env.RERANK_MODEL ?? 'Xenova/bge-reranker-base';
  readonly modelDtype = process.env.MODEL_DTYPE ?? 'q8';
  readonly modelCacheDir = process.env.MODEL_CACHE_DIR ?? 'data/model_cache';
  readonly inferenceRequestTimeoutSeconds = Number(
    process.env.INFERENCE_REQUEST_TIMEOUT_SECONDS ?? 180,
  );
  readonly inferenceMaxPending = Number(process.env.INFERENCE_MAX_PENDING ?? 32);
  readonly similarityThreshold = Number(process.env.SIMILARITY_THRESHOLD ?? 0.15);
  readonly ragTopK = Number(process.env.RAG_TOP_K ?? 5);
  readonly rerankTopN = Number(process.env.RERANK_TOP_N ?? 10);
  readonly agentToolSelection = process.env.AGENT_TOOL_SELECTION ?? (this.runtimeMode === 'test' ? 'auto' : 'llm');
  readonly queryExpansionEnabled = boolEnv('QUERY_EXPANSION_ENABLED', true);
  readonly queryExpansionMaxVariants = Number(
    process.env.QUERY_EXPANSION_MAX_VARIANTS ?? 3,
  );
  readonly llmApiKey = process.env.LLM_API_KEY ?? '';
  readonly llmProvider = process.env.LLM_PROVIDER ?? 'openai';
  readonly llmBaseUrl = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(
    /\/$/,
    '',
  );
  readonly llmModel = process.env.LLM_MODEL ?? '';
  readonly llmTimeoutSeconds = Number(process.env.LLM_TIMEOUT_SECONDS ?? 60);
  readonly llmContextWindow = Number(process.env.LLM_CONTEXT_WINDOW ?? 32768);
  readonly summaryMaxOutputTokens = Number(process.env.SUMMARY_MAX_OUTPUT_TOKENS ?? 2048);
  readonly summarySafetyRatio = Number(process.env.SUMMARY_SAFETY_RATIO ?? 0.15);
  readonly summaryMapInputTokens = Number(process.env.SUMMARY_MAP_INPUT_TOKENS ?? 6000);
  readonly llmToolCallExtraBody = jsonObjectEnv('LLM_TOOL_CALL_EXTRA_BODY');
  readonly llmModelProfiles = jsonObjectEnv('LLM_MODEL_PROFILES');
  readonly agentModelRoutes = jsonObjectEnv('AGENT_MODEL_ROUTES');
  readonly llmCircuitFailureThreshold = Number(process.env.LLM_CIRCUIT_FAILURE_THRESHOLD ?? 3);
  readonly llmCircuitCooldownMs = Number(process.env.LLM_CIRCUIT_COOLDOWN_MS ?? 30000);
  readonly documentAgentEnabled = boolEnv('DOCUMENT_AGENT_ENABLED', true);
  readonly workspaceEnabled = boolEnv('WORKSPACE_ENABLED', true);
  readonly mcpEnabled = boolEnv('MCP_ENABLED', false);
  readonly mcpServers = jsonObjectEnv('MCP_SERVERS');
  // Explicit deployment configuration: native DashScope search also returns source metadata.
  readonly agentWebSearchUrl = process.env.AGENT_WEB_SEARCH_URL ?? '';
  readonly agentWebSearchModel = process.env.AGENT_WEB_SEARCH_MODEL || this.llmModel;
  readonly thinkingSupported = boolEnv('AGENT_THINKING_SUPPORTED', false);
  readonly agentSettingsEncryptionKey = process.env.AGENT_SETTINGS_ENCRYPTION_KEY ?? '';
  readonly thinkingOnBody = jsonObjectEnv('AGENT_THINKING_ON_BODY');
  readonly thinkingOffBody = jsonObjectEnv('AGENT_THINKING_OFF_BODY');
  readonly agentClassifierModel = process.env.AGENT_CLASSIFIER_MODEL || this.llmModel;
  readonly agentPlanModel = process.env.AGENT_PLAN_MODEL || this.llmModel;
  readonly agentCriticModel = process.env.AGENT_CRITIC_MODEL || this.llmModel;
  readonly agentTimeoutSeconds = Number(process.env.AGENT_TIMEOUT_SECONDS ?? 300);
  readonly agentGraphEnabled = boolEnv('AGENT_GRAPH_ENABLED', false);
  readonly agentGraphRetentionDays = Number(process.env.AGENT_GRAPH_RETENTION_DAYS ?? 7);
  readonly agentMaxToolCalls = Number(process.env.AGENT_MAX_TOOL_CALLS ?? 24);
  readonly agentMaxOutputTokens = Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? 4096);
  readonly agentMaxTotalTokens = Number(process.env.AGENT_MAX_TOTAL_TOKENS ?? 120000);
  readonly agentMaxModelRequests = Number(process.env.AGENT_MAX_MODEL_REQUESTS ?? 30);
  readonly agentFinalizationTokens = Number(process.env.AGENT_FINALIZATION_TOKENS ?? 8192);
  readonly agentMaxConcurrentRuns = Number(process.env.AGENT_MAX_CONCURRENT_RUNS ?? 6);
  readonly memoryStore = process.env.MEMORY_STORE ?? this.metadataStore;
  readonly memoryMaxMessages = Number(process.env.MEMORY_MAX_MESSAGES ?? 12);
  readonly memoryMaxTurns = Number(process.env.MEMORY_MAX_TURNS ?? 6);
  readonly shortMemoryTokenBudget = Number(
    process.env.SHORT_MEMORY_TOKEN_BUDGET ?? 4000,
  );
  readonly conversationConstraintsEnabled = boolEnv('CONVERSATION_CONSTRAINTS_ENABLED', this.runtimeMode !== 'test');
  readonly memoryTtlDays = Number(process.env.MEMORY_TTL_DAYS ?? 30);
  readonly documentMemoryEnabled = boolEnv('DOCUMENT_MEMORY_ENABLED', true);
  readonly documentMemoryTokenBudget = Number(
    process.env.DOCUMENT_MEMORY_TOKEN_BUDGET ?? 500,
  );
  readonly documentMemoryMinConfidence = Number(
    process.env.DOCUMENT_MEMORY_MIN_CONFIDENCE ?? 0.7,
  );
  readonly documentMemoryMaxAttempts = Number(
    process.env.DOCUMENT_MEMORY_MAX_ATTEMPTS ?? 3,
  );
  readonly documentMemoryLeaseSeconds = Number(
    process.env.DOCUMENT_MEMORY_LEASE_SECONDS ?? 300,
  );
  readonly indexJobStore = process.env.INDEX_JOB_STORE ?? this.metadataStore;
  readonly observabilityStore = process.env.OBSERVABILITY_STORE ?? this.metadataStore;
  readonly indexWorkerPollSeconds = Number(
    process.env.INDEX_WORKER_POLL_SECONDS ?? 1,
  );
  readonly indexJobLeaseSeconds = Number(process.env.INDEX_JOB_LEASE_SECONDS ?? 900);
  readonly indexJobMaxAttempts = Number(process.env.INDEX_JOB_MAX_ATTEMPTS ?? 3);
  readonly indexJobBatchSize = Number(process.env.INDEX_JOB_BATCH_SIZE ?? 5);
  readonly importJobStore = process.env.IMPORT_JOB_STORE ?? this.metadataStore;
  readonly importWorkerPollSeconds = Number(process.env.IMPORT_WORKER_POLL_SECONDS ?? 1);
  readonly importJobLeaseSeconds = Number(process.env.IMPORT_JOB_LEASE_SECONDS ?? 1800);
  readonly importJobMaxAttempts = Number(process.env.IMPORT_JOB_MAX_ATTEMPTS ?? 3);
  readonly importMaxUploadMb = Number(process.env.IMPORT_MAX_UPLOAD_MB ?? 50);
  readonly importRetentionDays = Number(process.env.IMPORT_RETENTION_DAYS ?? 7);
  readonly storageProvider = process.env.STORAGE_PROVIDER ?? 'local';
  readonly storageLocalRoot = process.env.STORAGE_LOCAL_ROOT ?? 'data/storage';
  readonly doclingPython = process.env.DOCLING_PYTHON ?? 'python';
  readonly doclingScript = process.env.DOCLING_SCRIPT ?? 'scripts/docling_parse.py';
  readonly doclingNumThreads = Math.max(1, Number(process.env.DOCLING_NUM_THREADS ?? 1));
  readonly visionApiBaseUrl = (process.env.VISION_API_BASE_URL ?? '').replace(/\/$/u, '');
  readonly visionApiKey = process.env.VISION_API_KEY ?? '';
  readonly visionModel = process.env.VISION_MODEL ?? '';
  readonly visionTimeoutSeconds = Number(process.env.VISION_TIMEOUT_SECONDS ?? 45);
  readonly metricsRetentionDays = Number(process.env.METRICS_RETENTION_DAYS ?? 90);
  readonly contextTokenBudget = Number(process.env.CONTEXT_TOKEN_BUDGET ?? 1500);
  readonly contextPerCitationTokens = Number(
    process.env.CONTEXT_PER_CITATION_TOKENS ?? 420,
  );
  readonly tokenizerEncoding = process.env.TOKENIZER_ENCODING ?? 'cl100k_base';

  /**
   * 为配置生成稳定摘要，识别部署设置变化。
   *
   * @returns 整理后的文本或标识。
   */
  get configFingerprint(): string {
    const payload = JSON.stringify({
      collection: this.qdrantCollection,
      qdrant_auth: Boolean(this.qdrantApiKey),
      embedding_provider: this.embeddingProvider,
      embedding_model: this.embeddingModel,
      embedding_dim: this.embeddingDim,
      chunk_max_tokens: this.chunkMaxTokens,
      chunk_overlap_tokens: this.chunkOverlapTokens,
      sparse_provider: this.sparseEmbeddingProvider,
      rerank_provider: this.rerankProvider,
      rerank_model: this.rerankModel,
      llm_provider: this.llmProvider,
      llm_model: this.llmModel,
      llm_tool_call_extra_body: this.llmToolCallExtraBody,
      llm_base_url: this.llmBaseUrl,
      model_routing_fingerprint: new ModelRouter(this).fingerprint(),
      context_token_budget: this.contextTokenBudget,
      context_per_citation_tokens: this.contextPerCitationTokens,
      tokenizer_encoding: this.tokenizerEncoding,
      similarity_threshold: this.similarityThreshold,
      rerank_top_n: this.rerankTopN,
      query_expansion_enabled: this.queryExpansionEnabled,
      query_expansion_max_variants: this.queryExpansionMaxVariants,
      agent_tool_selection: this.agentToolSelection,
      agent_max_total_tokens: this.agentMaxTotalTokens,
      agent_max_model_requests: this.agentMaxModelRequests,
      agent_finalization_tokens: this.agentFinalizationTokens,
      storage_provider: this.storageProvider,
      docling_python: this.doclingPython,
      docling_script: this.doclingScript,
      docling_num_threads: this.doclingNumThreads,
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /**
   * 读取并规范化当前图任务协议版本。
   *
   * @returns "v1" | "v2" 类型的处理结果。
   */
  get agentGraphVersion(): 'v1' | 'v2' {
    return process.env.AGENT_GRAPH_VERSION === 'v1' ? 'v1' : 'v2';
  }

  /**
   * 列出生产运行所缺少或不兼容的配置。
   *
   * @returns 整理后的字符串列表。
   */
  productionMisconfigurations(): string[] {
    return this.realMisconfigurations();
  }

  /**
   * 检查真实模型与持久化组件运行所需的配置。
   *
   * @returns 整理后的字符串列表。
   */
  realMisconfigurations(): string[] {
    const requirements: Record<string, boolean> = {
      METADATA_STORE: this.metadataStore === 'mysql',
      MEMORY_STORE: this.memoryStore === 'mysql',
      INDEX_JOB_STORE: this.indexJobStore === 'mysql',
      IMPORT_JOB_STORE: this.importJobStore === 'mysql',
      OBSERVABILITY_STORE: this.observabilityStore === 'mysql',
      VECTOR_STORE: this.vectorStore === 'qdrant',
      EMBEDDING_PROVIDER: this.embeddingProvider === 'transformers',
      SPARSE_EMBEDDING_PROVIDER: this.sparseEmbeddingProvider === 'qdrant_idf',
      RERANK_PROVIDER: this.rerankProvider === 'bge',
      AGENT_TOOL_SELECTION: this.agentToolSelection === 'llm',
      AGENT_MAX_TOTAL_TOKENS: Number.isInteger(this.agentMaxTotalTokens) && this.agentMaxTotalTokens > 0,
      AGENT_MAX_MODEL_REQUESTS: Number.isInteger(this.agentMaxModelRequests) && this.agentMaxModelRequests >= 3,
      AGENT_FINALIZATION_TOKENS: Number.isInteger(this.agentFinalizationTokens) && this.agentFinalizationTokens >= 0 && this.agentFinalizationTokens < this.agentMaxTotalTokens,
      AGENT_MAX_CONCURRENT_RUNS: Number.isInteger(this.agentMaxConcurrentRuns) && this.agentMaxConcurrentRuns > 0,
      LLM_API_KEY: new ModelRouter(this).configured(),
      LLM_MODEL: Boolean(new ModelRouter(this).mainModel()),
      DATABASE_URL: Boolean(this.databaseUrl),
      STORAGE_PROVIDER: this.storageProvider === 'local',
      STORAGE_LOCAL_ROOT: Boolean(this.storageLocalRoot),
      DOCLING_PYTHON: Boolean(this.doclingPython),
      DOCLING_SCRIPT: existsSync(resolve(this.projectRoot, this.doclingScript)),
      CHUNK_MAX_TOKENS:
        Number.isInteger(this.chunkMaxTokens) && this.chunkMaxTokens >= 64,
      CHUNK_OVERLAP_TOKENS:
        Number.isInteger(this.chunkOverlapTokens) &&
        this.chunkOverlapTokens >= 0 &&
        this.chunkOverlapTokens < this.chunkMaxTokens,
    };
    return Object.entries(requirements)
      .filter(([, valid]) => !valid)
      .map(([name]) => name);
  }

  /**
   * 在服务启动前校验运行模式及必要依赖配置。
   */
  validateRuntime(): void {
    if (!Number.isInteger(this.agentGraphRetentionDays) || this.agentGraphRetentionDays < 1)
      throw new Error('AGENT_GRAPH_RETENTION_DAYS must be a positive integer');
    if (this.agentGraphEnabled && this.metadataStore !== 'mysql')
      throw new Error('AGENT_GRAPH_ENABLED requires METADATA_STORE=mysql');
    if (this.runtimeMode === 'test' && this.appEnv !== 'production') return;
    const invalid = this.realMisconfigurations();
    if (invalid.length) {
      throw new Error(
        `Real RAG configuration is incomplete. Configure in ${this.envFile}: ${invalid.join(', ')}`,
      );
    }
  }

  /**
   * 生成不包含敏感凭据的运行配置摘要。
   *
   * @returns Record<string, unknown> 类型的处理结果。
   */
  summary(): Record<string, unknown> {
    return {
      env_file: this.envFile,
      app_env: this.appEnv,
      runtime_mode: this.runtimeMode,
      metadata_store: this.metadataStore,
      agent_graph_enabled: this.agentGraphEnabled,
      agent_graph_retention_days: this.agentGraphRetentionDays,
      vector_store: this.vectorStore,
      qdrant_collection: this.qdrantCollection,
      embedding_provider: this.embeddingProvider,
      embedding_model: this.embeddingModel,
      embedding_dim: this.embeddingDim,
      chunk_max_tokens: this.chunkMaxTokens,
      chunk_overlap_tokens: this.chunkOverlapTokens,
      sparse_embedding_provider: this.sparseEmbeddingProvider,
      rerank_provider: this.rerankProvider,
      rerank_model: this.rerankModel,
      agent_tool_selection: this.agentToolSelection,
      llm_provider: this.llmProvider,
      llm_model: new ModelRouter(this).mainModel() || null,
      llm_configured: new ModelRouter(this).configured(),
      model_profile_names: Object.keys(this.llmModelProfiles),
      llm_tool_call_extra_body_keys: Object.keys(this.llmToolCallExtraBody).sort(),
      storage_provider: this.storageProvider,
      storage_local_root: resolve(this.projectRoot, this.storageLocalRoot),
      docling_python: this.doclingPython,
      docling_script: resolve(this.projectRoot, this.doclingScript),
      docling_num_threads: this.doclingNumThreads,
      missing: this.realMisconfigurations(),
      config_fingerprint: this.configFingerprint,
    };
  }
}
