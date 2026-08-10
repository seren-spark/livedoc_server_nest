import { Injectable } from '@nestjs/common';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const configDir = dirname(fileURLToPath(import.meta.url));
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

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function csvEnv(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

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
  readonly llmToolCallExtraBody = jsonObjectEnv('LLM_TOOL_CALL_EXTRA_BODY');
  readonly memoryStore = process.env.MEMORY_STORE ?? this.metadataStore;
  readonly memoryMaxMessages = Number(process.env.MEMORY_MAX_MESSAGES ?? 12);
  readonly memoryTtlDays = Number(process.env.MEMORY_TTL_DAYS ?? 30);
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
  readonly editorDocumentTokenBudget = Number(
    process.env.EDITOR_DOCUMENT_TOKEN_BUDGET ?? 6000,
  );
  readonly tokenizerEncoding = process.env.TOKENIZER_ENCODING ?? 'cl100k_base';

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
      storage_provider: this.storageProvider,
      docling_python: this.doclingPython,
      docling_script: this.doclingScript,
      docling_num_threads: this.doclingNumThreads,
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  productionMisconfigurations(): string[] {
    return this.realMisconfigurations();
  }

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
      LLM_API_KEY: Boolean(this.llmApiKey),
      LLM_MODEL: Boolean(this.llmModel),
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

  validateRuntime(): void {
    if (this.runtimeMode === 'test' && this.appEnv !== 'production') return;
    const invalid = this.realMisconfigurations();
    if (invalid.length) {
      throw new Error(
        `Real RAG configuration is incomplete. Configure in ${this.envFile}: ${invalid.join(', ')}`,
      );
    }
  }

  summary(): Record<string, unknown> {
    return {
      env_file: this.envFile,
      app_env: this.appEnv,
      runtime_mode: this.runtimeMode,
      metadata_store: this.metadataStore,
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
      llm_model: this.llmModel || null,
      llm_configured: Boolean(this.llmApiKey),
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
