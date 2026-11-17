/**
 * @file RAG 检索主链路。编排分块入库、查询变体、混合召回、权限过滤、重排和证据压缩。
 */
import { selectEvidence } from './evidence-selection.js';
import { prepareEmbeddingChunks } from './embedding-chunks.js';
import { Injectable, Optional } from "@nestjs/common";
import { ArticleRepository } from '../articles/article.repository.js';
import { DocumentCatalog } from '../database/document-catalog.js';
import { randomUUID } from "node:crypto";
import type { SearchDto } from "../common/dto.js";
import type {
  AccessContext,
  Citation,
  RetrievalTrace,
  RetrievalDebug,
} from "../common/types.js";
import { AppConfig } from "../config/app-config.js";
import type { DocumentIndexRequest } from "../documents/document.types.js";
import { EmbeddingService } from "../inference/embedding.service.js";
import { RerankerService } from "../inference/reranker.service.js";
import { ObservabilityService } from "../observability/observability.service.js";
import { chunkMarkdown } from "./chunker.js";
import { ContextCompressorService } from "./context-compressor.service.js";
import { SparseEmbeddingService } from "./sparse-embedding.service.js";
import { cosineSimilarity, elapsedMs, round } from "./text-utils.js";
import {
  bm25Search,
  type SearchHit,
  VectorStoreService,
} from "./vector-store.service.js";

type ExpansionSource = RetrievalTrace["expansion_source"];

@Injectable()
export class RetrievalService {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param embeddings EmbeddingService 依赖实例。
   * @param sparse SparseEmbeddingService 依赖实例。
   * @param store VectorStoreService 依赖实例。
   * @param reranker RerankerService 依赖实例。
   * @param compressor ContextCompressorService 依赖实例。
   * @param observability ObservabilityService 依赖实例。
   * @param articleDrafts ArticleRepository 依赖实例（可选）。
   * @param catalog 当前可用文档、技能或来源目录（可选）。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly embeddings: EmbeddingService,
    private readonly sparse: SparseEmbeddingService,
    private readonly store: VectorStoreService,
    private readonly reranker: RerankerService,
    private readonly compressor: ContextCompressorService,
    private readonly observability: ObservabilityService,
    @Optional() private readonly articleDrafts?: ArticleRepository,
    @Optional() private readonly catalog?: DocumentCatalog,
  ) {}

  /**
   * 结构化分块并生成稠密、稀疏向量，写入指定版本的文档索引。
   *
   * @param document 当前知识文档记录。
   * @param activate 写入后是否立即激活该版本的索引。
   * @returns 成功生成并写入的分块数量。
   */
  async indexDocument(
    document: DocumentIndexRequest,
    activate = true,
  ): Promise<number> {
    const { chunks, passages } = await this.prepareChunksForEmbedding(
      document.doc_id,
      document.title,
      document.content,
    );
    //生成 Dense 向量。 vectors 是 number[][] ，每个 passage 对应一个稠密向量。
    const vectors = await this.embeddings.embedBatch(passages);
    //生成 Sparse 向量。 sparseVectors 是 SparseEmbedding[]
    //这里是 同步 调用（没有 await），因为 Sparse 是本地基于词频计算的，不需要模型推理。
    const sparseVectors = passages.map((passage) => this.sparse.embedDocument(passage));
    //把 chunks、Dense 向量、Sparse 向量一起写入 Qdrant
    await this.store.upsertChunks(
      document,
      chunks,
      vectors,
      sparseVectors,
      activate,
    );
    return chunks.length;
  }
  /**
   * 检索
   * @param request 搜索请求
   * @param context 用户身份、space_id、team_ids（权限控制）
   * @param queryVariants 搜索查询变体
   * @param expansionSource 变体来源标记：'original' / 'tool_call' / 'fallback'
   * @param preprocessingMs 预处理耗时
   * @returns 检索结果
   */
  async searchWithTrace(
    request: SearchDto,
    context: AccessContext,
    queryVariants?: string[],
    expansionSource: ExpansionSource = "original",
    preprocessingMs = 0,
  ): Promise<{ citations: Citation[]; trace: RetrievalTrace; retrieval_debug?: RetrievalDebug }> {
    return this.searchAuthorizedWithTrace(request, context, queryVariants, expansionSource, preprocessingMs,
      async hits => this.catalog ? this.catalog.readableHits(hits, context) : hits);
  }

  /**
   * 对衍生知识执行检索，在重排和压缩前核验其来源权限。
   *
   *  Internal derived-knowledge entry: provenance is checked before reranking or compression.
   *
   * @param request 包含查询文本、检索范围与返回数量的请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param authorize 向量库或关键词召回得到的候选命中。
   * @returns 引用证据与本次检索追踪。
   */
  async searchWikiWithTrace(request: SearchDto, context: AccessContext,
    authorize: (hits: SearchHit[]) => Promise<SearchHit[]>) {
    return this.searchAuthorizedWithTrace(request, context, undefined, "original", 0, authorize, true);
  }

  /**
   * 执行混合召回，在重排和压缩前校验候选权限，并记录完整检索链路。
   *
   * @param request 包含查询文本、检索范围与返回数量的请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param queryVariants 围绕原问题生成的检索查询变体。
   * @param expansionSource 查询变体来自原文、模型扩展或回退的标记。
   * @param preprocessingMs 查询预处理耗时，单位为毫秒。
   * @param authorize 向量库或关键词召回得到的候选命中。
   * @param wikiOnly wikiOnly 参数。
   * @returns 经过权限检查、重排和压缩的引用证据与检索追踪。
   */
  private async searchAuthorizedWithTrace(request: SearchDto, context: AccessContext,
    queryVariants: string[] | undefined, expansionSource: ExpansionSource, preprocessingMs: number,
    authorize: (hits: SearchHit[]) => Promise<SearchHit[]>, wikiOnly = false): Promise<{ citations: Citation[]; trace: RetrievalTrace; retrieval_debug?: RetrievalDebug }> {
    const totalStarted = performance.now();
    //prepareQueryVariants（查询变体准备）
    const preparedQueryVariants = prepareQueryVariants(
      request.query,
      request.context,
      queryVariants,
    );
    const rewrittenQuery = preparedQueryVariants[0] ?? request.query;
    const retrievalStarted = performance.now();
    //多查询检索
    const { denseHits, keywordHits, candidateHits } = await this.retrieveMultiQuery(
      request,
      context,
      preparedQueryVariants,
      wikiOnly,
    );
    const retrievalMs = elapsedMs(retrievalStarted);
    const readableCandidates = await authorize(candidateHits);
    const rerankStarted = performance.now();
    //rerank 精排
    const rerankedHits = request.rerank === false ? readableCandidates : await this.reranker.rerank(
      rewrittenQuery,
      readableCandidates,
      this.config.rerankTopN,
    );
    const rerankMs = elapsedMs(rerankStarted);
    //去重
    const seenPages = new Set<string>();
    const readableRanked = this.articleDrafts ? await this.articleDrafts.filterHits(rerankedHits) : rerankedHits;
    const dedupedHits = wikiOnly ? readableRanked.filter(hit => {
      const id = String(hit.payload.doc_id);
      if (seenPages.has(id)) return false;
      seenPages.add(id);
      return true;
    }) : dedupeHits(readableRanked);
    //转换为 Citation
    const selectionStrategy = wikiOnly || request.evidence_selection === false ? 'rank-v1' : 'facet-v1';
    const selectedHits = selectionStrategy === 'rank-v1'
      ? dedupedHits.slice(0, request.top_k)
      : selectEvidence(dedupedHits, request.query, request.top_k);
    const uncompressedCitations = selectedHits
      .map((hit, index) => hitToCitation(index + 1, hit));
    const compressionStarted = performance.now();
    //压缩上下文
    // Wiki search selects pages; WikiService supplies the verified body and original evidence.
    const citations = wikiOnly ? uncompressedCitations : this.compressor.compress(uncompressedCitations, rewrittenQuery);
    const trace: RetrievalTrace = {
      trace_id: randomUUID().replaceAll("-", ""),
      mode: request.mode,
      rewritten_query: rewrittenQuery,
      query_variants: preparedQueryVariants,
      expansion_source: expansionSource,
      expansion_enabled: preparedQueryVariants.length > 1,
      dense_candidates: denseHits.length,
      keyword_candidates: keywordHits.length,
      fused_candidates: candidateHits.length,
      reranked_candidates: request.rerank === false ? 0 : Math.min(readableCandidates.length, this.config.rerankTopN),
      deduped_candidates: dedupedHits.length,
      returned_citations: citations.length,
      retrieval_ms: retrievalMs,
      rerank_ms: rerankMs,
      compression_ms: elapsedMs(compressionStarted),
      preprocessing_ms: preprocessingMs,
      total_ms: round(elapsedMs(totalStarted) + preprocessingMs, 2),
    };
    await this.observability.recordSearch(
      trace,
      context,
      request.query,
      citations,
    );
    if (request.include_retrieval_debug) {
      // Apply the same publication boundary as final citations before exposing diagnostics.
      const eligible = await authorize(this.articleDrafts ? await this.articleDrafts.filterHits(readableCandidates) : readableCandidates);
      return { citations, trace, retrieval_debug: {
        schema_version: 1, candidate_stage: 'authorized_fused_before_rerank', candidate_limit: 20,
        selection_strategy: selectionStrategy,
        candidates: eligible.slice(0, 20).map((hit, index) => hitToCitation(index + 1, hit)),
        ranked: uncompressedCitations,
      } };
    }
    return { citations, trace };
  }

  /**
   * 在当前文档范围内检索证据，并返回可观测的检索信息。
   *
   * @param options 当前用户、空间与团队身份，用于权限校验。
   * @returns 引用证据与本次检索追踪。
   */
  async searchCurrentDocumentWithTrace(options: {
    query: string;
    title: string;
    content: string;
    topK?: number;
    contextText?: string;
    queryVariants?: string[];
    expansionSource?: ExpansionSource;
    preprocessingMs?: number;
    context?: AccessContext;
  }): Promise<{ citations: Citation[]; trace: RetrievalTrace }> {
    const totalStarted = performance.now();

    const preparedQueryVariants = prepareQueryVariants(
      options.query,
      options.contextText ?? "",
      options.queryVariants,
    );
    const rewrittenQuery = preparedQueryVariants[0] ?? options.query;
    const traceId = randomUUID().replaceAll("-", "");
    if (!options.content.trim()) {
      const trace = emptyTrace(
        traceId,
        rewrittenQuery,
        preparedQueryVariants,
        options.expansionSource,
        options.preprocessingMs,
        totalStarted,
      );
      await this.observability.recordSearch(
        trace,
        options.context ?? null,
        options.query,
        [],
        "current_document",
      );
      return { citations: [], trace };
    }
    const retrievalStarted = performance.now();
    const { chunks, passages } = await this.prepareChunksForEmbedding(
      "current_document",
      options.title || "当前打开文档",
      options.content,
    );
    const vectors = await this.embeddings.embedBatch(passages);
    const payloads = chunks.map((chunk, index) => {
      return {
        chunk_id: chunk.chunk_id,
        doc_id: "current_document",
        space_id: "current_document",
        team_id: null,
        visibility: "private",
        source_type: "current_document",
        title: options.title || "当前打开文档",
        content: chunk.retrieval_content ?? chunk.content,
        source_content: chunk.content,
        heading_path: chunk.heading_path,
        chunk_index: chunk.chunk_index,
        ordinal: chunk.ordinal,
        source_anchor: chunk.source_anchor,
        document_version: 1,
        document_updated_at: null,
        is_active: true,
        tags: [],
        url: null,
        start_offset: chunk.start_offset,
        end_offset: chunk.end_offset,
        vector: vectors[index]!,
      };
    });
    const candidateLimit = Math.max((options.topK ?? 5) * 4, 20);
    const denseRankings: SearchHit[][] = [];
    const keywordRankings: SearchHit[][] = [];
    const keywordDocuments = payloads.map((payload) => [payload.chunk_id, payload] as const);
    for (const queryVariant of preparedQueryVariants) {
      const queryVector = await this.embeddings.embed(queryVariant);
      const denseHits = payloads
        .map((payload) => ({
          pointId: payload.chunk_id,
          score: cosineSimilarity(queryVector, payload.vector),
          payload: { ...payload, vector: undefined },
        }))
        .filter((hit) => hit.score >= this.config.similarityThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateLimit);
      denseRankings.push(denseHits);
      keywordRankings.push(
        bm25Search(
          queryVariant,
          keywordDocuments,
          candidateLimit,
          this.sparse,
        ),
      );
    }
    const denseHits = mergeRankingsUnique(denseRankings);
    const keywordHits = mergeRankingsUnique(keywordRankings);
    const candidateHits = rrfFuseMany([
      ...denseRankings.map((hits) => ["dense", hits] as const),
      ...keywordRankings.map((hits) => ["keyword", hits] as const),
    ]);
    const retrievalMs = elapsedMs(retrievalStarted);
    const rerankStarted = performance.now();
    const rerankedHits = await this.reranker.rerank(
      rewrittenQuery,
      candidateHits,
      this.config.rerankTopN,
    );
    const rerankMs = elapsedMs(rerankStarted);
    const dedupedHits = dedupeHits(rerankedHits);
    const uncompressedCitations = selectEvidence(dedupedHits, options.query, options.topK ?? 5)
      .map((hit, index) => hitToCitation(index + 1, hit));
    const compressionStarted = performance.now();
    const citations = this.compressor.compress(uncompressedCitations, rewrittenQuery);
    const preprocessingMs = options.preprocessingMs ?? 0;
    const trace: RetrievalTrace = {
      trace_id: traceId,
      mode: "hybrid",
      rewritten_query: rewrittenQuery,
      query_variants: preparedQueryVariants,
      expansion_source: options.expansionSource ?? "original",
      expansion_enabled: preparedQueryVariants.length > 1,
      dense_candidates: denseHits.length,
      keyword_candidates: keywordHits.length,
      fused_candidates: candidateHits.length,
      reranked_candidates: Math.min(candidateHits.length, this.config.rerankTopN),
      deduped_candidates: dedupedHits.length,
      returned_citations: citations.length,
      retrieval_ms: retrievalMs,
      rerank_ms: rerankMs,
      compression_ms: elapsedMs(compressionStarted),
      preprocessing_ms: preprocessingMs,
      total_ms: round(elapsedMs(totalStarted) + preprocessingMs, 2),
    };
    await this.observability.recordSearch(
      trace,
      options.context ?? null,
      options.query,
      citations,
      "current_document",
    );
    return { citations, trace };
  }

  /**
   * 多查询召回
   * @param request 搜索请求
   * @param context 上下文
   * @param preparedQueryVariants 多个查询变体（原始查询 + 改写/扩展的查询）
   * @returns 合并后的召回结果
   *
   * @param wikiOnly wikiOnly 参数。
   */
  private async retrieveMultiQuery(
    request: SearchDto,
    context: AccessContext,
    preparedQueryVariants: string[], // 多个查询变体（原始查询 + 改写/扩展的查询）
    wikiOnly = false,
  ) {
    const denseRankings: SearchHit[][] = []; // 存储每路 Dense 召回结果
    const keywordRankings: SearchHit[][] = []; // 存储每路 Sparse 召回结果
    const candidateLimit = Math.max(request.top_k * 4, 20); // 多召回一些，后续再裁剪
    // 对每个查询变体分别执行两路召回
    for (const queryVariant of preparedQueryVariants) {
      // Dense 召回：语义相似度
      if (request.mode === "dense" || request.mode === "hybrid") {
        denseRankings.push(
          // 检索 Dense 召回结果
          await this.store.search(
            await this.embeddings.embed(queryVariant), // 先计算查询向量
            context,
            request.scope,
            candidateLimit,
            this.config.similarityThreshold,
            wikiOnly,
          ),
        );
      }
      // Sparse 召回：关键词匹配
      if (request.mode === "keyword" || request.mode === "hybrid") {
        keywordRankings.push(
          await this.store.keywordSearch(
            queryVariant,
            this.sparse.embedQuery(queryVariant), // 计算查询的稀疏向量
            context,
            request.scope,
            candidateLimit,
            wikiOnly,
          ),
        );
      }
    }
    // 构建融合输入：标记每个结果来自哪个通道
    const rankings = [
      ...denseRankings.map((hits) => ["dense", hits] as const),
      ...keywordRankings.map((hits) => ["keyword", hits] as const),
    ];
    return {
      denseHits: mergeRankingsUnique(denseRankings), // 合并所有 Dense 结果
      keywordHits: mergeRankingsUnique(keywordRankings), // 合并所有 Sparse 结果
      candidateHits: rrfFuseMany(rankings), // RRF 融合
    };
  }
  /**
   * 确保切出来的 chunks 在真实 tokenizer 下不超过预算
   * @param docId 知识文档标识。
   * @param title 文档或界面标题。
   * @param content 待处理的正文内容。
   * @returns 用于向量化的文档分块及其完整输入文本。
   */
  private async prepareChunksForEmbedding(
    docId: string,
    title: string,
    content: string,
  ): Promise<{ chunks: ReturnType<typeof chunkMarkdown>; passages: string[] }> {
    return prepareEmbeddingChunks(docId, title, content, this.config, this.embeddings);
  }
}

/**
 * 查询变体准备
 * @param originalQuery 原始查询
 * @param _contextText 上下文（未使用）
 * @param queryVariants 变体查询
 * @return string[]  去重后的查询变体列表
 */
export function prepareQueryVariants(
  originalQuery: string,
  _contextText: string,
  queryVariants?: string[],
): string[] {
  //最终返回的 query 列表
  const preparedQueryVariants: string[] = [];
  //用于去重的集合（小写后的 key）
  const seen = new Set<string>();
  //把原问题放在最前面，再接上变体查询
  for (const queryVariant of [originalQuery, ...(queryVariants ?? [])]) {
    //转字符串 → 去首尾空格 → 连续空格压缩为单个
    const normalizedQuery = String(queryVariant).trim().replace(/\s+/g, " ");
    //小写化用于去重判断
    const key = normalizedQuery.toLocaleLowerCase();
    if (!normalizedQuery || seen.has(key)) continue;
    seen.add(key);
    preparedQueryVariants.push(normalizedQuery);
  }
  return preparedQueryVariants.length ? preparedQueryVariants : [originalQuery.trim()];
}

/**
 * RRF 融合算法
 * @param rankings 合并所有后的结果列表
 * @param k RRF 常数，平滑排名影响
 * @returns 融合后的结果列表，按 RRF 分数降序排序
 */
export function rrfFuseMany(
  rankings: ReadonlyArray<readonly ["dense" | "keyword", SearchHit[]]>,
  k = 60, // RRF 常数，平滑排名影响
): SearchHit[] {
  const byChunk = new Map<string, SearchHit>(); // 存储每个 chunk 的最佳结果
  const scores = new Map<string, number>(); // RRF 融合分数
  const denseScores = new Map<string, number>(); // Dense 通道最高分
  const keywordScores = new Map<string, number>(); // Sparse 通道最高分
  // 遍历所有通道的所有结果

  for (const [channel, hits] of rankings) {
    hits.forEach((hit, index) => {
      const key = String(hit.payload.chunk_id ?? hit.pointId);
      const current = byChunk.get(key);
      // 保留 score 最高的那个 hit（用于后续展示 payload）
      if (!current || hit.score > current.score) byChunk.set(key, hit);
      // RRF 核心公式：score = Σ 1/(k + rank)
      // rank 从 0 开始，所以 +1；k 是平滑常数（默认60）
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + index + 1));
      // 记录每个通道的最高原始分数（用于调试和可观测性）
      const channelScores = channel === "dense" ? denseScores : keywordScores;
      channelScores.set(
        key,
        Math.max(channelScores.get(key) ?? Number.NEGATIVE_INFINITY, hit.score),
      );
    });
  }
  // 按 RRF 分数降序排序
  return [...byChunk.entries()]
    .map(([key, hit]) => ({
      ...hit,
      score: scores.get(key) ?? 0, // 用 RRF 分数替换原始分数
      payload: {
        ...hit.payload,
        dense_score: denseScores.get(key), // 附加 Dense 原始分
        keyword_score: keywordScores.get(key), // 附加 Sparse 原始分
      },
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * 合并多个召回排名并去重，保留各来源提供的候选。
 *
 * @param rankings 向量库或关键词召回得到的候选命中。
 * @returns 检索候选命中列表。
 */
export function mergeRankingsUnique(rankings: SearchHit[][]): SearchHit[] {
  const byChunk = new Map<string, SearchHit>();
  for (const hits of rankings) {
    for (const hit of hits) {
      const key = String(hit.payload.chunk_id ?? hit.pointId);
      const current = byChunk.get(key);
      if (!current || hit.score > current.score) byChunk.set(key, hit);
    }
  }
  return [...byChunk.values()].sort((a, b) => b.score - a.score);
}

/**
 * 去重
 * @param hits 原始 hit 列表
 * @returns 去重后的 hit 列表
 */
export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  //按位置精确去重，保留"最新版本 + 最高分"。
  const latest = new Map<string, SearchHit>();
  for (const hit of hits) {
    const key = `${hit.payload.doc_id}:${hit.payload.chunk_index}`;
    const current = latest.get(key);
    if (!current) latest.set(key, hit);
    else {
      const currentVersion = Number(current.payload.document_version ?? 1);
      const nextVersion = Number(hit.payload.document_version ?? 1);
      //遇到相同 key 时，优先保留 document_version 更大 的
      //版本相同时，保留 score 更高 的
      if (
        nextVersion > currentVersion ||
        (nextVersion === currentVersion && hit.score > current.score)
      )
        latest.set(key, hit);
    }
  }
  //按内容前缀去重
  const seen = new Set<string>(); //同时记录 position 和 content 前 160 字符
  const result: SearchHit[] = [];
  //先按 score 降序排序，高分优先保留
  for (const hit of [...latest.values()].sort((a, b) => b.score - a.score)) {
    const position = `${hit.payload.doc_id}:${hit.payload.chunk_index}`;
    const content = String(hit.payload.content ?? "").slice(0, 160);
    if (seen.has(position) || seen.has(content)) continue;
    seen.add(position);
    seen.add(content);
    result.push(hit);
  }
  return result;
}

/**
 * 把索引命中转换为带原文位置和来源元数据的引用。
 *
 * @param index 当前条目或块的序号。
 * @param hit 向量库或关键词召回得到的候选命中。
 * @returns 引用证据。
 */
function hitToCitation(index: number, hit: SearchHit): Citation {
  const payload = hit.payload;
  return {
    citation_id: `${String(payload.doc_id)}:${Number(payload.document_version ?? 1)}:${String(payload.chunk_id)}`,
    index,
    doc_id: String(payload.doc_id),
    chunk_id: String(payload.chunk_id),
    title: String(payload.title),
    content: String(payload.content ?? ""),
    source_content: String(payload.source_content ?? payload.content ?? ""),
    snippet: String(payload.source_content ?? payload.content ?? "").slice(0, 320),
    source_anchor: String(
      payload.source_anchor ?? `chunk-${String(payload.chunk_id)}`,
    ),
    source_type: payload.source_type,
    visibility: payload.visibility,
    score: round(hit.score, 4),
    retrieval_score: round(Number(payload.pre_rerank_score ?? hit.score), 4),
    dense_score: payload.dense_score ?? null,
    keyword_score: payload.keyword_score ?? null,
    rerank_score: payload.rerank_score ?? null,
    url: payload.visibility === 'public' && ['article', 'public_article'].includes(payload.source_type)
      ? `/post/${String(payload.doc_id)}` : payload.url ?? null,
    heading_path: [...(payload.heading_path ?? [])],
    chunk_index: payload.chunk_index ?? null,
    space_id: String(payload.space_id),
    team_id: payload.team_id ?? null,
    document_version: Number(payload.document_version ?? 1),
    document_updated_at: payload.document_updated_at
      ? String(payload.document_updated_at)
      : null,
    start_offset: payload.start_offset ?? null,
    end_offset: payload.end_offset ?? null,
  };
}

/**
 * 构造无候选或提前结束时使用的初始检索追踪。
 *
 * @param traceId 检索追踪标识。
 * @param rewrittenQuery 用于召回或记录追踪的改写查询。
 * @param preparedQueryVariants 已规范化并去重的查询变体。
 * @param expansionSource 查询变体来自原文、模型扩展或回退的标记。
 * @param preprocessingMs 查询预处理耗时，单位为毫秒。
 * @param totalStarted 整个处理流程的起始计时点（可选）。
 * @returns 检索链路追踪。
 */
function emptyTrace(
  traceId: string,
  rewrittenQuery: string,
  preparedQueryVariants: string[],
  expansionSource: ExpansionSource = "original",
  preprocessingMs = 0,
  totalStarted?: number,
): RetrievalTrace {
  return {
    trace_id: traceId,
    mode: "hybrid",
    rewritten_query: rewrittenQuery,
    query_variants: preparedQueryVariants,
    expansion_source: expansionSource,
    expansion_enabled: preparedQueryVariants.length > 1,
    dense_candidates: 0,
    keyword_candidates: 0,
    fused_candidates: 0,
    reranked_candidates: 0,
    deduped_candidates: 0,
    returned_citations: 0,
    retrieval_ms: 0,
    rerank_ms: 0,
    compression_ms: 0,
    preprocessing_ms: preprocessingMs,
    total_ms: round(
      (totalStarted === undefined ? 0 : elapsedMs(totalStarted)) +
        preprocessingMs,
      2,
    ),
  };
}
