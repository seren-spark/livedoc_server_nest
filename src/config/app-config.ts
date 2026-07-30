import { Injectable } from '@nestjs/common';
import 'dotenv/config';

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

@Injectable()
export class AppConfig {
  readonly appEnv = process.env.APP_ENV ?? 'development';
  readonly host = process.env.APP_HOST ?? '127.0.0.1';
  readonly port = Number(process.env.APP_PORT ?? 8001);
  readonly allowedOrigins = csvEnv(
    'ALLOWED_ORIGINS',
    this.appEnv === 'production'
      ? ''
      : 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000',
  );
  readonly metadataStore = process.env.METADATA_STORE ?? 'memory';
  readonly databaseUrl = process.env.DATABASE_URL ?? '';
  readonly vectorStore = process.env.VECTOR_STORE ?? 'memory';
  readonly qdrantUrl = process.env.QDRANT_URL ?? 'http://127.0.0.1:6335';
  readonly qdrantCollection =
    process.env.QDRANT_COLLECTION ?? 'article_chunks_nest_v1';
  readonly embeddingProvider = process.env.EMBEDDING_PROVIDER ?? 'hash';
  readonly embeddingModel =
    process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-zh-v1.5';
  readonly embeddingDim = Number(process.env.EMBEDDING_DIM ?? 384);
  readonly sparseEmbeddingProvider =
    process.env.SPARSE_EMBEDDING_PROVIDER ?? 'memory_bm25';
  readonly sparseEmbeddingModel =
    process.env.SPARSE_EMBEDDING_MODEL ?? 'Qdrant/bm25';
  readonly rerankProvider = process.env.RERANK_PROVIDER ?? 'heuristic';
  readonly rerankModel =
    process.env.RERANK_MODEL ?? 'Xenova/bge-reranker-base';
  readonly modelDtype = process.env.MODEL_DTYPE ?? 'q8';
  readonly modelCacheDir = process.env.MODEL_CACHE_DIR ?? 'data/model_cache';
  readonly similarityThreshold = Number(process.env.SIMILARITY_THRESHOLD ?? 0.15);
  readonly ragTopK = Number(process.env.RAG_TOP_K ?? 5);
  readonly rerankTopN = Number(process.env.RERANK_TOP_N ?? 10);
  readonly agentToolSelection = process.env.AGENT_TOOL_SELECTION ?? 'auto';
  readonly queryExpansionEnabled = boolEnv('QUERY_EXPANSION_ENABLED', true);
  readonly queryExpansionMaxVariants = Number(
    process.env.QUERY_EXPANSION_MAX_VARIANTS ?? 3,
  );
  readonly llmApiKey = process.env.LLM_API_KEY ?? '';
  readonly llmProvider = process.env.LLM_PROVIDER ?? 'openai_compatible';
  readonly llmBaseUrl = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(
    /\/$/,
    '',
  );
  readonly llmModel = process.env.LLM_MODEL ?? 'gpt-4.1-mini';
  readonly llmTimeoutSeconds = Number(process.env.LLM_TIMEOUT_SECONDS ?? 30);
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
  readonly metricsRetentionDays = Number(process.env.METRICS_RETENTION_DAYS ?? 90);
  readonly contextTokenBudget = Number(process.env.CONTEXT_TOKEN_BUDGET ?? 1500);
  readonly contextPerCitationTokens = Number(
    process.env.CONTEXT_PER_CITATION_TOKENS ?? 420,
  );
  readonly tokenizerEncoding = process.env.TOKENIZER_ENCODING ?? 'cl100k_base';

  productionMisconfigurations(): string[] {
    const requirements: Record<string, boolean> = {
      METADATA_STORE: this.metadataStore === 'mysql',
      MEMORY_STORE: this.memoryStore === 'mysql',
      INDEX_JOB_STORE: this.indexJobStore === 'mysql',
      OBSERVABILITY_STORE: this.observabilityStore === 'mysql',
      VECTOR_STORE: this.vectorStore === 'qdrant',
      EMBEDDING_PROVIDER: this.embeddingProvider === 'transformers',
      SPARSE_EMBEDDING_PROVIDER: this.sparseEmbeddingProvider === 'ts_bm25',
      RERANK_PROVIDER: this.rerankProvider === 'bge',
      AGENT_TOOL_SELECTION: this.agentToolSelection === 'llm',
      LLM_API_KEY: Boolean(this.llmApiKey),
      DATABASE_URL: Boolean(this.databaseUrl),
    };
    return Object.entries(requirements)
      .filter(([, valid]) => !valid)
      .map(([name]) => name);
  }

  validateRuntime(): void {
    if (this.appEnv !== 'production') return;
    const invalid = this.productionMisconfigurations();
    if (invalid.length) {
      throw new Error(
        `Production configuration cannot use smoke fallbacks. Configure: ${invalid.join(', ')}`,
      );
    }
  }
}
