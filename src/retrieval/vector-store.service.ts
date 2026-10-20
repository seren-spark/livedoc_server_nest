import { Injectable, OnModuleInit } from "@nestjs/common";
import { QdrantClient } from "@qdrant/js-client-rest";
import { v5 as uuidV5 } from "uuid";
import type { AccessContext, KnowledgeScope } from "../common/types.js";
import { AppConfig } from "../config/app-config.js";
import type { DocumentIndexRequest } from "../documents/document.types.js";
import type { Chunk } from "./chunker.js";
import type { SparseEmbedding } from "./sparse-embedding.service.js";
import { SparseEmbeddingService } from "./sparse-embedding.service.js";
import { cosineSimilarity } from "./text-utils.js";

export interface SearchHit {
  pointId: string;
  score: number;
  payload: Record<string, any>;
}

@Injectable()
export class VectorStoreService implements OnModuleInit {
  readonly points = new Map<
    string,
    { vector: number[]; sparse?: SparseEmbedding; payload: Record<string, any> }
  >();

  async deactivateVersionsBefore(docId: string, version: number): Promise<void> {
    if (this.config.vectorStore === 'qdrant') {
      await this.qdrant.setPayload(this.config.qdrantCollection, { wait: true, payload: { is_active: false },
        filter: { must: [{ key: 'doc_id', match: { value: docId } }, { key: 'document_version', range: { lt: version } }] } });
    } else for (const point of this.points.values()) {
      if (point.payload.doc_id === docId && point.payload.document_version < version) point.payload.is_active = false;
    }
  }
  private readonly qdrant: QdrantClient;

  constructor(
    private readonly config: AppConfig,
    private readonly sparse: SparseEmbeddingService,
  ) {
    this.qdrant = new QdrantClient({
      url: config.qdrantUrl,
      ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}),
      checkCompatibility: false,
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.config.vectorStore === "qdrant") await this.ensureCollection();
  }

  async ensureCollection(): Promise<void> {
    const collections = await this.qdrant.getCollections();
    const exists = collections.collections.some(
      (item) => item.name === this.config.qdrantCollection,
    );
    if (!exists) {
      await this.qdrant.createCollection(this.config.qdrantCollection, {
        vectors: {
          dense: { size: this.config.embeddingDim, distance: "Cosine" },
        },
        sparse_vectors: { sparse: { modifier: "idf" } },
      } as any);
    } else {
      const info = await this.qdrant.getCollection(
        this.config.qdrantCollection,
      );
      const params = (info.config as any)?.params;
      if (
        !params?.vectors?.dense ||
        !params?.sparse_vectors?.sparse ||
        params.sparse_vectors.sparse.modifier !== 'idf'
      ) {
        throw new Error(
          `Qdrant collection '${this.config.qdrantCollection}' must use named dense vectors and sparse IDF. Re-index into a fresh collection.`,
        );
      }
    }
    const indexes: Array<[string, string]> = [
      ["space_id", "keyword"],
      ["team_id", "keyword"],
      ["owner_id", "keyword"],
      ["visibility", "keyword"],
      ["source_type", "keyword"],
      ["doc_id", "keyword"],
      ["document_version", "integer"],
      ["is_active", "bool"],
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
/**
 * 
 * @param document 文档索引请求，包含 doc_id、document_version、title、visibility 等元数据
 * @param chunks  Chunk 数组，由 chunkMarkdown 生成
 * @param vectors Dense 向量数组，由 BGE 模型生成
 * @param sparseVectors Sparse 向量数组，由 BM25 算法生成
 * @param activate 是否立即激活这些 points
 */
  async upsertChunks(
    document: DocumentIndexRequest,
    chunks: Chunk[],
    vectors: number[][],
    sparseVectors: SparseEmbedding[],
    activate = true,
  ): Promise<void> {
    const entries = chunks.map((chunk, index) => ({
      //为每个 chunk 生成唯一的 point ID
      id: uuidV5(`${chunk.chunk_id}:v${document.document_version}`, uuidV5.URL),
      //Qdrant 的 named vectors。一个 point 同时有 dense 和 sparse 两个向量。
      vector: { dense: vectors[index]!, sparse: sparseVectors[index]! },
      //payload 存元数据：doc_id、visibility、team_id、space_id、chunk content、is_active 等
      payload: { ...buildPayload(document, chunk), is_active: activate },
    }));
    //如果配置 Qdrant，批量 upsert；否则存内存 Map
    if (this.config.vectorStore === "qdrant") {
      await this.qdrant.upsert(this.config.qdrantCollection, {
        wait: true,//等待写入完成再返回
        points: entries, //批量 upsert 所有 entries
      } as any);
    } else {
      for (const entry of entries) {
        this.points.set(entry.id, {
          vector: entry.vector.dense,
          sparse: entry.vector.sparse,
          payload: entry.payload,
        });
      }
    }
    if (activate)
      await this.activateDocumentVersion(
        document.doc_id,
        document.document_version,
      );
  }
  /**
   * 搜索
   * @param queryVector 查询的稠密向量（768维或1536维）
   * @param context 用户权限上下文
   * @param scope 权限范围
   * @param limit 返回数量限制
   * @param scoreThreshold 相似度阈值
   * @returns 搜索结果列表，按 score 降序排序
   * @returns SearchHit 搜索结果项，包含 pointId、score、payload
   * @returns pointId 点 ID（chunk ID）
   * @returns score 相似度分数（0-1之间）
   * @returns payload 元数据（包含 doc_id、visibility、team_id、space_id、chunk content 等）
   */
  async search(
    queryVector: number[], // 查询的稠密向量（768维或1536维）
    context: AccessContext,// 用户权限上下文
    scope: KnowledgeScope,// 权限范围
    limit: number,// 返回数量限制
    scoreThreshold: number,// 相似度阈值
  ): Promise<SearchHit[]> {
    if (this.config.vectorStore === "qdrant") {
      const result = await this.qdrant.query(this.config.qdrantCollection, {
        query: queryVector,// 传入查询向量
        using: "dense", // 使用 dense 命名向量
        filter: buildPermissionFilter(context, scope), // 应用权限过滤
        limit,
        score_threshold: scoreThreshold,
        with_payload: true, // 返回完整 payload
      } as any);
      return (result.points ?? []).map((point: any) => ({
        pointId: String(point.id),
        score: Number(point.score ?? 0),
        payload: point.payload ?? {},
      }));
    }
    // 内存模式的降级实现（用于测试）
    return [...this.points.entries()]
      .filter(([, item]) => canAccess(item.payload, context, scope))
      .map(([pointId, item]) => ({
        pointId,
        score: cosineSimilarity(queryVector, item.vector),
        payload: { ...item.payload },
      }))
      .filter((item) => item.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  /**
   * 搜索
   * @param query 原始查询文本
   * @param querySparse 查询的稀疏向量（词袋表示）
   * @param context 用户权限上下文
   * @param scope 权限范围
   * @param limit 返回数量限制
   * @returns 搜索结果列表，按 score 降序排序
   * @returns SearchHit 搜索结果项，包含 pointId、score、payload
   * @returns pointId 点 ID（chunk ID）
   * @returns score 相似度分数（0-1之间）
   * @returns payload 元数据（包含 doc_id、visibility、team_id、space_id、chunk content 等）
   */
  async keywordSearch(
    query: string,
    querySparse: SparseEmbedding, // 查询的稀疏向量（词袋表示）
    context: AccessContext,
    scope: KnowledgeScope,
    limit: number,
  ): Promise<SearchHit[]> {
    if (this.config.vectorStore === "qdrant") {
      const result = await this.qdrant.query(this.config.qdrantCollection, {
        query: querySparse,
        using: "sparse",
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
    // 内存模式使用 BM25 算法
    const documents = [...this.points.entries()]
      .filter(([, item]) => canAccess(item.payload, context, scope))
      .map(([pointId, item]) => [pointId, item.payload] as const);
    return bm25Search(query, documents, limit, this.sparse);
  }

  async deactivateDocument(docId: string): Promise<void> {
    if (this.config.vectorStore === "qdrant") {
      await this.qdrant.setPayload(this.config.qdrantCollection, {
        payload: { is_active: false },
        filter: { must: [{ key: "doc_id", match: { value: docId } }] },
        wait: true,
      } as any);
      return;
    }
    for (const item of this.points.values())
      if (item.payload.doc_id === docId) item.payload.is_active = false;
  }

  async activateDocumentVersion(docId: string, version: number): Promise<void> {
    if (this.config.vectorStore === "qdrant") {
      await this.qdrant.setPayload(this.config.qdrantCollection, {
        payload: { is_active: true },
        filter: {
          must: [
            { key: "doc_id", match: { value: docId } },
            { key: "document_version", match: { value: version } },
          ],
        },
        wait: true,
      } as any);
      await this.qdrant.setPayload(this.config.qdrantCollection, {
        payload: { is_active: false },
        filter: {
          must: [{ key: "doc_id", match: { value: docId } }],
          must_not: [{ key: "document_version", match: { value: version } }],
        },
        wait: true,
      } as any);
      return;
    }
    for (const item of this.points.values()) {
      if (item.payload.doc_id === docId)
        item.payload.is_active = item.payload.document_version === version;
    }
  }

  async deleteDocumentVersion(docId: string, version: number): Promise<void> {
    if (this.config.vectorStore === "qdrant") {
      await this.qdrant.delete(this.config.qdrantCollection, {
        wait: true,
        filter: {
          must: [
            { key: "doc_id", match: { value: docId } },
            { key: "document_version", match: { value: version } },
          ],
        },
      } as any);
      return;
    }
    for (const [id, item] of this.points) {
      if (
        item.payload.doc_id === docId &&
        item.payload.document_version === version
      )
        this.points.delete(id);
    }
  }

  async deleteDocument(docId: string): Promise<void> {
    if (this.config.vectorStore === "qdrant") {
      await this.qdrant.delete(this.config.qdrantCollection, {
        wait: true,
        filter: { must: [{ key: "doc_id", match: { value: docId } }] },
      } as any);
      return;
    }
    for (const [id, item] of this.points)
      if (item.payload.doc_id === docId) this.points.delete(id);
  }
}

export function buildPayload(
  document: DocumentIndexRequest,
  chunk: Chunk,
): Record<string, any> {
  return {
    chunk_id: chunk.chunk_id,
    doc_id: document.doc_id,
    space_id: document.space_id,
    team_id: document.team_id,
    owner_id: document.owner_id,
    visibility: document.visibility,
    source_type: document.source_type,
    title: document.title,
    content: chunk.retrieval_content ?? chunk.content,
    source_content: chunk.content,
    heading_path: chunk.heading_path,
    chunk_index: chunk.chunk_index,
    ordinal: chunk.ordinal,
    source_anchor: chunk.source_anchor,
    start_offset: chunk.start_offset,
    end_offset: chunk.end_offset,
    document_version: document.document_version,
    document_updated_at: document.document_updated_at,
    is_active: true,
    tags: document.tags,
    url: document.url,
  };
}

export function buildPermissionFilter(
  context: AccessContext, // 包含 user_id, space_id, team_ids 等用户上下文
  scope: KnowledgeScope,// 包含 private/team/public 开关和 document_ids 列表
): Record<string, any> {
  // 第1步：必须满足的基础条件 - 只检索激活的文档片段
  const must: any[] = [{ key: "is_active", match: { value: true } }];
  const should: any[] = [];
  // 第2步：如果指定了文档ID范围，限制在这些文档内
  if (scope.document_ids.length)
    must.push({ key: "doc_id", match: { any: scope.document_ids } });
   // 第3步：私有文档权限 - 只能看自己的
  if (scope.private) {
    should.push({
      must: [
        { key: "visibility", match: { value: "private" } },
        { key: "space_id", match: { value: context.space_id } },
        { key: "owner_id", match: { value: context.user_id } },
      ],
    });
  }
  // 第4步：团队文档权限 - 必须是团队成员
  if (scope.team && context.team_ids.length) {
    should.push({
      must: [
        { key: "visibility", match: { value: "team" } },
        { key: "space_id", match: { value: context.space_id } },
        { key: "team_id", match: { any: context.team_ids } },
      ],
    });
  }
  // 第5步：公开文档权限 - 所有人可见
  if (scope.public)
    should.push({ must: [{ key: "visibility", match: { value: "public" } }] });
  // 第6步：如果没有任何权限分支，添加拒绝条件（防止全量返回）
  if (!should.length)
    must.push({ key: "__deny_all__", match: { value: true } });
  return { must, should };
}

export function canAccess(
  payload: Record<string, any>,
  context: AccessContext,
  scope: KnowledgeScope,
): boolean {
  if (payload.is_active !== true) return false;
  if (
    scope.document_ids.length &&
    !scope.document_ids.includes(String(payload.doc_id))
  )
    return false;
  if (payload.visibility === "private") {
    return (
      scope.private &&
      payload.space_id === context.space_id &&
      payload.owner_id === context.user_id
    );
  }
  if (payload.visibility === "team") {
    return (
      scope.team &&
      payload.space_id === context.space_id &&
      context.team_ids.includes(String(payload.team_id))
    );
  }
  return payload.visibility === "public" && scope.public;
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
    for (const term of terms)
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { pointId, payload, terms, frequencies };
  });
  const averageLength =
    tokenized.reduce((sum, item) => sum + item.terms.length, 0) /
    tokenized.length;
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      tokenized.filter((item) => item.frequencies.has(term)).length,
    );
  }
  return tokenized
    .map((item) => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = item.frequencies.get(term) ?? 0;
        if (!frequency) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (tokenized.length - df + 0.5) / (df + 0.5));
        const denominator =
          frequency +
          k1 * (1 - b + (b * item.terms.length) / Math.max(averageLength, 1));
        score += (idf * frequency * (k1 + 1)) / denominator;
      }
      return { pointId: item.pointId, score, payload: { ...item.payload } };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function searchableText(payload: Record<string, any>): string {
  return [
    payload.title ?? "",
    payload.content ?? "",
    ...(payload.tags ?? []),
    ...(payload.heading_path ?? []),
  ]
    .join(" ")
    .toLowerCase();
}
