/**
 * @file 可检索文档目录。统一筛选当前用户可读且版本有效的知识文档与文章命中。
 */
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "./database.service.js";
import type { DocumentRecord } from "../documents/document.types.js";
import type { SearchHit } from "../retrieval/vector-store.service.js";
import type { AccessContext } from "../common/types.js";
import { mapDocumentRow } from "../documents/documents.repository.js";
import { canAccessDocument } from "../documents/document-access.js";
@Injectable()
export class DocumentCatalog {
  readonly records = new Map<string, DocumentRecord>();
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param db 共享数据库服务。
   */
  constructor(private readonly db: DatabaseService) {}
  /**
   * 依据当前文档和文章目录，保留用户可读且版本有效的检索命中。
   *
   * @param hits 向量库或关键词召回得到的候选命中。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 检索候选命中列表。
   */
  async readableHits(hits: SearchHit[], context: AccessContext) {
    const ids = [...new Set(hits.map((h) => String(h.payload.doc_id)))];
    if (!ids.length) return [];
    const records = this.db.metadataEnabled
      ? (
          await this.db.query<Record<string, unknown>>(
            `SELECT * FROM knowledge_documents WHERE doc_id IN (${ids.map(() => "?").join(",")})`,
            ids,
          )
        ).map(mapDocumentRow)
      : ids
          .map((id) => this.records.get(id))
          .filter((r): r is DocumentRecord => Boolean(r));
    const byId = new Map(records.map((r) => [r.doc_id, r]));
    return hits.filter((hit) => {
      const record = byId.get(String(hit.payload.doc_id));
      return (
        record &&
        canAccessDocument(record, context) &&
        record.active_index_version === Number(hit.payload.document_version)
      );
    });
  }
}
