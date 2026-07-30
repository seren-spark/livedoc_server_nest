import { Injectable, OnModuleInit } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import { v5 as uuidV5 } from 'uuid';
import type { AccessContext, KnowledgeScope } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import type { DocumentIndexRequest } from '../documents/document.types.js';
import type { Chunk } from './chunker.js';
import type { SparseEmbedding } from './sparse-embedding.service.js';
import { SparseEmbeddingService } from './sparse-embedding.service.js';
import { cosineSimilarity } from './text-utils.js';

export interface SearchHit {
  pointId: string;
  score: number;
  payload: Record<string, any>;
}

@Injectable()
export class VectorStoreService implements OnModuleInit {
  readonly points = new Map<string, { vector: number[]; sparse?: SparseEmbedding; payload: Record<string, any> }>();
  private readonly qdrant: QdrantClient;

  constructor(
    private readonly config: AppConfig,
    private readonly sparse: SparseEmbeddingService,
  ) {
    this.qdrant = new QdrantClient({ url: config.qdrantUrl, checkCompatibility: false });
  }

  async onModuleInit(): Promise<void> {
    if (this.config.vectorStore === 'qdrant') await this.ensureCollection();
  }

  async ensureCollection(): Promise<void> {
    const collections = await this.qdrant.getCollections();
    const exists = collections.collections.some((item) => item.name === this.config.qdrantCollection);
    if (!exists) {
      await this.qdrant.createCollection(this.config.qdrantCollection, {
        vectors: { dense: { size: this.config.embeddingDim, distance: 'Cosine' } },
        sparse_vectors: { sparse: { modifier: 'idf' } },
      } as any);
    } else {
      const info = await this.qdrant.getCollection(this.config.qdrantCollection);
      const params = (info.config as any)?.params;
      if (!params?.vectors?.dense || !params?.sparse_vectors?.sparse) {
        throw new Error(
          `Qdrant collection '${this.config.qdrantCollection}' is not named dense+sparse. Re-index into a fresh collection.`,
        );
      }
    }
    const indexes: Array<[string, string]> = [
      ['space_id', 'keyword'],
      ['team_id', 'keyword'],
      ['owner_id', 'keyword'],
      ['visibility', 'keyword'],
      ['source_type', 'keyword'],
      ['doc_id', 'keyword'],
      ['document_version', 'integer'],
      ['is_active', 'bool'],
    ];
    for (const [field_name, field_schema] of indexes) {
      try {
        await this.qdrant.createPayloadIndex(this.config.qdrantCollection, {
          field_name,
          field_schema: field_schema as any,
          wait: true,
        });
      } catch {
        // Existing indexes are idempotent; a schema failure is caught by integration tests.
      }
    }
  }

  async upsertChunks(
    document: DocumentIndexRequest,
    chunks: Chunk[],
    vectors: number[][],
    sparseVectors: SparseEmbedding[],
    activate = true,
  ): Promise<void> {
    const entries = chunks.map((chunk, index) => ({
      id: uuidV5(`${chunk.chunk_id}:v${document.document_version}`, uuidV5.URL),
      vector: { dense: vectors[index]!, sparse: sparseVectors[index]! },
      payload: { ...buildPayload(document, chunk), is_active: activate },
    }));
    if (this.config.vectorStore === 'qdrant') {
      await this.qdrant.upsert(this.config.qdrantCollection, { wait: true, points: entries } as any);
    } else {
      for (const entry of entries) {
        this.points.set(entry.id, {
          vector: entry.vector.dense,
          sparse: entry.vector.sparse,
          payload: entry.payload,
        });
      }
    }
    if (activate) await this.activateDocumentVersion(document.doc_id, document.document_version);
  }

  async search(
    queryVector: number[],
    context: AccessContext,
    scope: KnowledgeScope,
    limit: number,
    scoreThreshold: number,
  ): Promise<SearchHit[]> {
    if (this.config.vectorStore === 'qdrant') {
      const result = await this.qdrant.query(this.config.qdrantCollection, {
        query: queryVector,
        using: 'dense',
        filter: buildPermissionFilter(context, scope),
        limit,
        score_threshold: scoreThreshold,
        with_payload: true,
      } as any);
      return (result.points ?? []).map((point: any) => ({
        pointId: String(point.id),
        score: Number(point.score ?? 0),
        payload: point.payload ?? {},
      }));
    }
    return [...this.points.entries()]
      .filter(([, item]) => canAccess(item.payload, context, scope))
      .map(([pointId, item]) => ({ pointId, score: cosineSimilarity(queryVector, item.vector), payload: { ...item.payload } }))
      .filter((item) => item.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async keywordSearch(
    query: string,
    querySparse: SparseEmbedding,
    context: AccessContext,
    scope: KnowledgeScope,
    limit: number,
  ): Promise<SearchHit[]> {
    if (this.config.vectorStore === 'qdrant') {
      const result = await this.qdrant.query(this.config.qdrantCollection, {
        query: querySparse,
        using: 'sparse',
        filter: buildPermissionFilter(context, scope),
        limit,
        with_payload: true,
      } as any);
      return (result.points ?? []).map((point: any) => ({
        pointId: String(point.id),
        score: Number(point.score ?? 0),
        payload: point.payload ?? {},
      }));
    }
    const documents = [...this.points.entries()]
      .filter(([, item]) => canAccess(item.payload, context, scope))
      .map(([pointId, item]) => [pointId, item.payload] as const);
    return bm25Search(query, documents, limit, this.sparse);
  }

  async deactivateDocument(docId: string): Promise<void> {
    if (this.config.vectorStore === 'qdrant') {
      await this.qdrant.setPayload(this.config.qdrantCollection, {
        payload: { is_active: false },
        filter: { must: [{ key: 'doc_id', match: { value: docId } }] },
        wait: true,
      } as any);
      return;
    }
    for (const item of this.points.values()) if (item.payload.doc_id === docId) item.payload.is_active = false;
  }

  async activateDocumentVersion(docId: string, version: number): Promise<void> {
    if (this.config.vectorStore === 'qdrant') {
      await this.qdrant.setPayload(this.config.qdrantCollection, {
        payload: { is_active: true },
        filter: { must: [{ key: 'doc_id', match: { value: docId } }, { key: 'document_version', match: { value: version } }] },
        wait: true,
      } as any);
      await this.qdrant.setPayload(this.config.qdrantCollection, {
        payload: { is_active: false },
        filter: {
          must: [{ key: 'doc_id', match: { value: docId } }],
          must_not: [{ key: 'document_version', match: { value: version } }],
        },
        wait: true,
      } as any);
      return;
    }
    for (const item of this.points.values()) {
      if (item.payload.doc_id === docId) item.payload.is_active = item.payload.document_version === version;
    }
  }

  async deleteDocumentVersion(docId: string, version: number): Promise<void> {
    if (this.config.vectorStore === 'qdrant') {
      await this.qdrant.delete(this.config.qdrantCollection, {
        wait: true,
        filter: { must: [{ key: 'doc_id', match: { value: docId } }, { key: 'document_version', match: { value: version } }] },
      } as any);
      return;
    }
    for (const [id, item] of this.points) {
      if (item.payload.doc_id === docId && item.payload.document_version === version) this.points.delete(id);
    }
  }

  async deleteDocument(docId: string): Promise<void> {
    if (this.config.vectorStore === 'qdrant') {
      await this.qdrant.delete(this.config.qdrantCollection, {
        wait: true,
        filter: { must: [{ key: 'doc_id', match: { value: docId } }] },
      } as any);
      return;
    }
    for (const [id, item] of this.points) if (item.payload.doc_id === docId) this.points.delete(id);
  }
}

export function buildPayload(document: DocumentIndexRequest, chunk: Chunk): Record<string, any> {
  return {
    chunk_id: chunk.chunk_id,
    doc_id: document.doc_id,
    space_id: document.space_id,
    team_id: document.team_id,
    owner_id: document.owner_id,
    visibility: document.visibility,
    source_type: document.source_type,
    title: document.title,
    content: chunk.content,
    heading_path: chunk.heading_path,
    chunk_index: chunk.chunk_index,
    document_version: document.document_version,
    is_active: true,
    tags: document.tags,
    url: document.url,
  };
}

export function buildPermissionFilter(context: AccessContext, scope: KnowledgeScope): Record<string, any> {
  const must: any[] = [{ key: 'is_active', match: { value: true } }];
  const should: any[] = [];
  if (scope.document_ids.length) must.push({ key: 'doc_id', match: { any: scope.document_ids } });
  if (scope.private) {
    should.push({ must: [
      { key: 'visibility', match: { value: 'private' } },
      { key: 'space_id', match: { value: context.space_id } },
      { key: 'owner_id', match: { value: context.user_id } },
    ] });
  }
  if (scope.team && context.team_ids.length) {
    should.push({ must: [
      { key: 'visibility', match: { value: 'team' } },
      { key: 'space_id', match: { value: context.space_id } },
      { key: 'team_id', match: { any: context.team_ids } },
    ] });
  }
  if (scope.public) should.push({ must: [{ key: 'visibility', match: { value: 'public' } }] });
  if (!should.length) must.push({ key: '__deny_all__', match: { value: true } });
  return { must, should };
}

export function canAccess(payload: Record<string, any>, context: AccessContext, scope: KnowledgeScope): boolean {
  if (payload.is_active !== true) return false;
  if (scope.document_ids.length && !scope.document_ids.includes(String(payload.doc_id))) return false;
  if (payload.visibility === 'private') {
    return scope.private && payload.space_id === context.space_id && payload.owner_id === context.user_id;
  }
  if (payload.visibility === 'team') {
    return scope.team && payload.space_id === context.space_id && context.team_ids.includes(String(payload.team_id));
  }
  return payload.visibility === 'public' && scope.public;
}

export function bm25Search(
  query: string,
  documents: ReadonlyArray<readonly [string, Record<string, any>]>,
  limit: number,
  sparse: SparseEmbeddingService,
  k1 = 1.5,
  b = 0.75,
): SearchHit[] {
  const queryTerms = [...new Set(sparse.tokenize(query))];
  if (!queryTerms.length || !documents.length) return [];
  const tokenized = documents.map(([pointId, payload]) => {
    const terms = sparse.tokenize(searchableText(payload));
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { pointId, payload, terms, frequencies };
  });
  const averageLength = tokenized.reduce((sum, item) => sum + item.terms.length, 0) / tokenized.length;
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(term, tokenized.filter((item) => item.frequencies.has(term)).length);
  }
  return tokenized
    .map((item) => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = item.frequencies.get(term) ?? 0;
        if (!frequency) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (tokenized.length - df + 0.5) / (df + 0.5));
        const denominator = frequency + k1 * (1 - b + (b * item.terms.length) / Math.max(averageLength, 1));
        score += (idf * frequency * (k1 + 1)) / denominator;
      }
      return { pointId: item.pointId, score, payload: { ...item.payload } };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function searchableText(payload: Record<string, any>): string {
  return [payload.title ?? '', payload.content ?? '', ...(payload.tags ?? []), ...(payload.heading_path ?? [])].join(' ').toLowerCase();
}
