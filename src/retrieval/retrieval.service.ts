import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SearchDto } from '../common/dto.js';
import type {
  AccessContext,
  Citation,
  RetrievalTrace,
} from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import type { DocumentIndexRequest } from '../documents/document.types.js';
import { EmbeddingService } from '../inference/embedding.service.js';
import { RerankerService } from '../inference/reranker.service.js';
import { ObservabilityService } from '../observability/observability.service.js';
import { chunkMarkdown } from './chunker.js';
import { ContextCompressorService } from './context-compressor.service.js';
import { SparseEmbeddingService } from './sparse-embedding.service.js';
import { cosineSimilarity, elapsedMs, round } from './text-utils.js';
import {
  bm25Search,
  type SearchHit,
  VectorStoreService,
} from './vector-store.service.js';

type ExpansionSource = RetrievalTrace['expansion_source'];

@Injectable()
export class RetrievalService {
  constructor(
    private readonly config: AppConfig,
    private readonly embeddings: EmbeddingService,
    private readonly sparse: SparseEmbeddingService,
    private readonly store: VectorStoreService,
    private readonly reranker: RerankerService,
    private readonly compressor: ContextCompressorService,
    private readonly observability: ObservabilityService,
  ) {}

  async indexDocument(document: DocumentIndexRequest, activate = true): Promise<number> {
    const chunks = chunkMarkdown(document.doc_id, document.title, document.content);
    const texts = chunks.map((chunk) =>
      [`title: ${chunk.title}`, `path: ${chunk.heading_path.join(' > ')}`, chunk.content].join('\n'),
    );
    const vectors = await this.embeddings.embedBatch(texts);
    const sparseVectors = texts.map((text) => this.sparse.embedDocument(text));
    await this.store.upsertChunks(document, chunks, vectors, sparseVectors, activate);
    return chunks.length;
  }

  async searchWithTrace(
    request: SearchDto,
    context: AccessContext,
    queryVariants?: string[],
    expansionSource: ExpansionSource = 'original',
    preprocessingMs = 0,
  ): Promise<{ citations: Citation[]; trace: RetrievalTrace }> {
    const totalStarted = performance.now();
    const queries = prepareQueryVariants(request.query, request.context, queryVariants);
    const rewritten = queries[0] ?? request.query;
    const retrievalStarted = performance.now();
    const { dense, keyword, candidates } = await this.retrieveMultiQuery(request, context, queries);
    const retrievalMs = elapsedMs(retrievalStarted);
    const rerankStarted = performance.now();
    const reranked = await this.reranker.rerank(rewritten, candidates, this.config.rerankTopN);
    const rerankMs = elapsedMs(rerankStarted);
    const deduped = dedupeHits(reranked);
    const raw = deduped.slice(0, request.top_k).map((hit, index) => hitToCitation(index + 1, hit));
    const compressionStarted = performance.now();
    const citations = this.compressor.compress(raw, rewritten);
    const trace: RetrievalTrace = {
      trace_id: randomUUID().replaceAll('-', ''),
      mode: request.mode,
      rewritten_query: rewritten,
      query_variants: queries,
      expansion_source: expansionSource,
      expansion_enabled: queries.length > 1,
      dense_candidates: dense.length,
      keyword_candidates: keyword.length,
      fused_candidates: candidates.length,
      reranked_candidates: Math.min(candidates.length, this.config.rerankTopN),
      deduped_candidates: deduped.length,
      returned_citations: citations.length,
      retrieval_ms: retrievalMs,
      rerank_ms: rerankMs,
      compression_ms: elapsedMs(compressionStarted),
      preprocessing_ms: preprocessingMs,
      total_ms: round(elapsedMs(totalStarted) + preprocessingMs, 2),
    };
    await this.observability.recordSearch(trace, context, request.query, citations);
    return { citations, trace };
  }

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
    const queries = prepareQueryVariants(options.query, options.contextText ?? '', options.queryVariants);
    const rewritten = queries[0] ?? options.query;
    const traceId = randomUUID().replaceAll('-', '');
    if (!options.content.trim()) {
      const trace = emptyTrace(
        traceId,
        rewritten,
        queries,
        options.expansionSource,
        options.preprocessingMs,
        totalStarted,
      );
      await this.observability.recordSearch(trace, options.context ?? null, options.query, [], 'current_document');
      return { citations: [], trace };
    }
    const retrievalStarted = performance.now();
    const chunks = chunkMarkdown('current_document', options.title || '当前打开文档', options.content);
    const passages = chunks.map((chunk) =>
      [`title: ${chunk.title}`, `path: ${chunk.heading_path.join(' > ')}`, chunk.content].join('\n'),
    );
    const vectors = await this.embeddings.embedBatch(passages);
    let offsetCursor = 0;
    const payloads = chunks.map((chunk, index) => {
      let startOffset = options.content.indexOf(chunk.content, offsetCursor);
      if (startOffset < 0) startOffset = options.content.indexOf(chunk.content);
      const endOffset = startOffset >= 0 ? startOffset + chunk.content.length : null;
      if (startOffset >= 0) offsetCursor = startOffset + 1;
      return {
        chunk_id: chunk.chunk_id,
        doc_id: 'current_document',
        space_id: 'current_document',
        team_id: null,
        visibility: 'private',
        source_type: 'current_document',
        title: options.title || '当前打开文档',
        content: chunk.content,
        heading_path: chunk.heading_path,
        chunk_index: chunk.chunk_index,
        document_version: 1,
        is_active: true,
        tags: [],
        url: null,
        start_offset: startOffset >= 0 ? startOffset : null,
        end_offset: endOffset,
        vector: vectors[index]!,
      };
    });
    const candidateLimit = Math.max((options.topK ?? 5) * 4, 20);
    const denseRankings: SearchHit[][] = [];
    const keywordRankings: SearchHit[][] = [];
    for (const variant of queries) {
      const queryVector = await this.embeddings.embed(variant);
      const dense = payloads
        .map((payload) => ({
          pointId: payload.chunk_id,
          score: cosineSimilarity(queryVector, payload.vector),
          payload: { ...payload, vector: undefined },
        }))
        .filter((hit) => hit.score >= this.config.similarityThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateLimit);
      denseRankings.push(dense);
      keywordRankings.push(
        bm25Search(
          variant,
          payloads.map((payload) => [payload.chunk_id, payload] as const),
          candidateLimit,
          this.sparse,
        ),
      );
    }
    const denseUnique = mergeRankingsUnique(denseRankings);
    const keywordUnique = mergeRankingsUnique(keywordRankings);
    const candidates = rrfFuseMany([
      ...denseRankings.map((hits) => ['dense', hits] as const),
      ...keywordRankings.map((hits) => ['keyword', hits] as const),
    ]);
    const retrievalMs = elapsedMs(retrievalStarted);
    const rerankStarted = performance.now();
    const reranked = await this.reranker.rerank(rewritten, candidates, this.config.rerankTopN);
    const rerankMs = elapsedMs(rerankStarted);
    const deduped = dedupeHits(reranked);
    const raw = deduped.slice(0, options.topK ?? 5).map((hit, index) => hitToCitation(index + 1, hit));
    const compressionStarted = performance.now();
    const citations = this.compressor.compress(raw, rewritten);
    const preprocessingMs = options.preprocessingMs ?? 0;
    const trace: RetrievalTrace = {
      trace_id: traceId,
      mode: 'hybrid',
      rewritten_query: rewritten,
      query_variants: queries,
      expansion_source: options.expansionSource ?? 'original',
      expansion_enabled: queries.length > 1,
      dense_candidates: denseUnique.length,
      keyword_candidates: keywordUnique.length,
      fused_candidates: candidates.length,
      reranked_candidates: Math.min(candidates.length, this.config.rerankTopN),
      deduped_candidates: deduped.length,
      returned_citations: citations.length,
      retrieval_ms: retrievalMs,
      rerank_ms: rerankMs,
      compression_ms: elapsedMs(compressionStarted),
      preprocessing_ms: preprocessingMs,
      total_ms: round(elapsedMs(totalStarted) + preprocessingMs, 2),
    };
    await this.observability.recordSearch(trace, options.context ?? null, options.query, citations, 'current_document');
    return { citations, trace };
  }

  private async retrieveMultiQuery(request: SearchDto, context: AccessContext, queries: string[]) {
    const denseRankings: SearchHit[][] = [];
    const keywordRankings: SearchHit[][] = [];
    const limit = Math.max(request.top_k * 4, 20);
    for (const query of queries) {
      if (request.mode === 'dense' || request.mode === 'hybrid') {
        denseRankings.push(
          await this.store.search(
            await this.embeddings.embed(query),
            context,
            request.scope,
            limit,
            this.config.similarityThreshold,
          ),
        );
      }
      if (request.mode === 'keyword' || request.mode === 'hybrid') {
        keywordRankings.push(
          await this.store.keywordSearch(
            query,
            this.sparse.embedQuery(query),
            context,
            request.scope,
            limit,
          ),
        );
      }
    }
    const rankings = request.mode === 'dense'
      ? denseRankings.map((hits) => ['dense', hits] as const)
      : request.mode === 'keyword'
        ? keywordRankings.map((hits) => ['keyword', hits] as const)
        : [
            ...denseRankings.map((hits) => ['dense', hits] as const),
            ...keywordRankings.map((hits) => ['keyword', hits] as const),
          ];
    return {
      dense: mergeRankingsUnique(denseRankings),
      keyword: mergeRankingsUnique(keywordRankings),
      candidates: rrfFuseMany(rankings),
    };
  }
}

export function prepareQueryVariants(original: string, context: string, variants?: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [original, ...(variants ?? [])]) {
    const normalized = String(candidate).trim().replace(/\s+/g, ' ');
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(context.trim() ? `${normalized}\n${context.trim().slice(-800)}` : normalized);
  }
  return result.length ? result : [original.trim()];
}

export function rrfFuseMany(
  rankings: ReadonlyArray<readonly ['dense' | 'keyword', SearchHit[]]>,
  k = 60,
): SearchHit[] {
  const byChunk = new Map<string, SearchHit>();
  const scores = new Map<string, number>();
  const denseScores = new Map<string, number>();
  const keywordScores = new Map<string, number>();
  for (const [channel, hits] of rankings) {
    hits.forEach((hit, index) => {
      const key = String(hit.payload.chunk_id ?? hit.pointId);
      const current = byChunk.get(key);
      if (!current || hit.score > current.score) byChunk.set(key, hit);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + index + 1));
      const channelScores = channel === 'dense' ? denseScores : keywordScores;
      channelScores.set(key, Math.max(channelScores.get(key) ?? Number.NEGATIVE_INFINITY, hit.score));
    });
  }
  return [...byChunk.entries()]
    .map(([key, hit]) => ({
      ...hit,
      score: scores.get(key) ?? 0,
      payload: {
        ...hit.payload,
        dense_score: denseScores.get(key),
        keyword_score: keywordScores.get(key),
      },
    }))
    .sort((a, b) => b.score - a.score);
}

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

export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const latest = new Map<string, SearchHit>();
  for (const hit of hits) {
    const key = `${hit.payload.doc_id}:${hit.payload.chunk_index}`;
    const current = latest.get(key);
    if (!current) latest.set(key, hit);
    else {
      const currentVersion = Number(current.payload.document_version ?? 1);
      const nextVersion = Number(hit.payload.document_version ?? 1);
      if (nextVersion > currentVersion || (nextVersion === currentVersion && hit.score > current.score)) latest.set(key, hit);
    }
  }
  const seen = new Set<string>();
  const result: SearchHit[] = [];
  for (const hit of [...latest.values()].sort((a, b) => b.score - a.score)) {
    const position = `${hit.payload.doc_id}:${hit.payload.chunk_index}`;
    const content = String(hit.payload.content ?? '').slice(0, 160);
    if (seen.has(position) || seen.has(content)) continue;
    seen.add(position);
    seen.add(content);
    result.push(hit);
  }
  return result;
}

function hitToCitation(index: number, hit: SearchHit): Citation {
  const payload = hit.payload;
  return {
    index,
    doc_id: String(payload.doc_id),
    chunk_id: String(payload.chunk_id),
    title: String(payload.title),
    content: String(payload.content ?? ''),
    source_type: payload.source_type,
    visibility: payload.visibility,
    score: round(hit.score, 4),
    dense_score: payload.dense_score ?? null,
    keyword_score: payload.keyword_score ?? null,
    rerank_score: payload.rerank_score ?? null,
    url: payload.url ?? null,
    heading_path: [...(payload.heading_path ?? [])],
    chunk_index: payload.chunk_index ?? null,
    space_id: String(payload.space_id),
    team_id: payload.team_id ?? null,
    document_version: Number(payload.document_version ?? 1),
    start_offset: payload.start_offset ?? null,
    end_offset: payload.end_offset ?? null,
  };
}

function emptyTrace(
  traceId: string,
  rewritten: string,
  queries: string[],
  source: ExpansionSource = 'original',
  preprocessingMs = 0,
  totalStarted?: number,
): RetrievalTrace {
  return {
    trace_id: traceId,
    mode: 'hybrid',
    rewritten_query: rewritten,
    query_variants: queries,
    expansion_source: source,
    expansion_enabled: queries.length > 1,
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
    total_ms: round((totalStarted === undefined ? 0 : elapsedMs(totalStarted)) + preprocessingMs, 2),
  };
}
