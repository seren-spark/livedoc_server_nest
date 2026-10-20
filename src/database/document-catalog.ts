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
  constructor(private readonly db: DatabaseService) {}
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
