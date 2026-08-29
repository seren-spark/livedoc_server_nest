export type DocumentMemoryStatus = 'pending' | 'extracting' | 'ready' | 'failed';
export type DocumentMemoryOrigin = 'auto' | 'user';
export type DocumentMemoryJobStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'superseded'
  | 'canceled';

export interface MemoryEvidence {
  hash: string;
  anchor: string;
  snippet: string;
}

interface MemoryItemBase {
  id: string;
  evidence: MemoryEvidence[];
  confidence: number;
  origin: DocumentMemoryOrigin;
  pinned: boolean;
}

export interface GlossaryMemoryItem extends MemoryItemBase {
  term: string;
  definition: string;
  aliases: string[];
}

export interface StyleMemoryItem extends MemoryItemBase {
  label: string;
  instruction: string;
}

export interface GlobalSettingMemoryItem extends MemoryItemBase {
  key: string;
  value: string;
}

export interface DocumentMemoryProfile {
  doc_id: string;
  space_id: string;
  source_document_version: number;
  memory_version: number;
  status: DocumentMemoryStatus;
  glossary: GlossaryMemoryItem[];
  style_tags: StyleMemoryItem[];
  global_settings: GlobalSettingMemoryItem[];
  suppressed_keys: string[];
  source_chunk_hashes: string[];
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EditableGlossaryItem {
  id?: string;
  term: string;
  definition: string;
  aliases?: string[];
}

export interface EditableStyleItem {
  id?: string;
  label: string;
  instruction: string;
}

export interface EditableGlobalSettingItem {
  id?: string;
  key: string;
  value: string;
}

export interface DocumentMemoryJobRecord {
  job_id: string;
  doc_id: string;
  document_version: number;
  generation: number;
  status: DocumentMemoryJobStatus;
  attempts: number;
  max_attempts: number;
  requested_by: string;
  space_id: string;
  force_full: boolean;
  dedupe_key: string | null;
  worker_id: string | null;
  lease_expires_at: Date | null;
  next_run_at: Date | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

export interface ExtractedDocumentMemory {
  glossary: Array<{
    term: string;
    definition: string;
    aliases?: string[];
    evidence_hashes?: string[];
    confidence: number;
  }>;
  style_tags: Array<{
    label: string;
    instruction: string;
    evidence_hashes?: string[];
    confidence: number;
  }>;
  global_settings: Array<{
    key: string;
    value: string;
    evidence_hashes?: string[];
    confidence: number;
  }>;
}
