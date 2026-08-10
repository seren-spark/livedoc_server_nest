import type { IndexStatus, SourceType, Visibility } from '../common/types.js';

export interface DocumentRecord {
  doc_id: string;
  space_id: string;
  title: string;
  content: string;
  visibility: Visibility;
  source_type: SourceType;
  tags: string[];
  team_id: string | null;
  owner_id: string | null;
  url: string | null;
  editor_content: Record<string, unknown> | null;
  source_import_id: string | null;
  assets?: unknown[];
  document_version: number;
  index_status: IndexStatus;
  active_index_version: number | null;
  latest_index_job_id: string | null;
  chunk_count: number;
  indexed_at: Date | null;
  index_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentIndexRequest {
  doc_id: string;
  space_id: string;
  title: string;
  content: string;
  visibility: Visibility;
  source_type: SourceType;
  tags: string[];
  team_id: string | null;
  owner_id: string | null;
  url: string | null;
  document_version: number;
  document_updated_at: string;
}

export function toIndexRequest(record: DocumentRecord): DocumentIndexRequest {
  return {
    doc_id: record.doc_id,
    space_id: record.space_id,
    title: record.title,
    content: record.content,
    visibility: record.visibility,
    source_type: record.source_type,
    tags: [...record.tags],
    team_id: record.team_id,
    owner_id: record.owner_id,
    url: record.url,
    document_version: record.document_version,
    document_updated_at: record.updated_at.toISOString(),
  };
}
