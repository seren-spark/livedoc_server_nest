import type { ImportStatus, Visibility } from '../common/types.js';
import type { PublicDocumentAsset } from '../documents/asset.types.js';

export interface DocumentImportRecord {
  import_id: string;
  space_id: string;
  owner_id: string;
  visibility: Visibility;
  team_id: string | null;
  tags: string[];
  folder: string | null;
  title: string;
  filename: string;
  mime_type: string;
  file_size: number;
  sha256: string;
  source_asset_id: string;
  status: ImportStatus;
  progress: number;
  stage: string;
  parsed_content: string;
  editor_content: Record<string, unknown> | null;
  parser_version: string | null;
  error: string | null;
  document_id: string | null;
  latest_job_id: string | null;
  assets?: PublicDocumentAsset[];
  created_at: Date;
  updated_at: Date;
}

export interface ImportJobRecord {
  job_id: string;
  import_id: string;
  status: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'canceled';
  attempts: number;
  max_attempts: number;
  generation: number;
  requested_by: string;
  space_id: string;
  config_fingerprint: string;
  worker_id: string | null;
  lease_expires_at: Date | null;
  next_run_at: Date;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

export interface ParsedImage {
  filename: string;
  mime_type: string;
  data_base64: string;
  ordinal: number;
  page_number: number | null;
  width: number | null;
  height: number | null;
  ocr_text: string;
  ocr_error: string | null;
}

export interface ParsedDocument {
  title: string;
  markdown: string;
  parser_version: string;
  images: ParsedImage[];
}
