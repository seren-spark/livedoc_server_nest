export type DocumentMemoryStatus =
  | "pending"
  | "extracting"
  | "ready"
  | "failed";
export type DocumentMemoryJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "superseded"
  | "canceled";

export interface MemoryEvidence {
  hash: string;
  anchor: string;
  snippet: string;
}

interface MemoryItemBase {
  id: string;
  evidence: MemoryEvidence[];
  confidence: number;
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
  source_document_version: number;  //文档版本号
  status: DocumentMemoryStatus;  //状态：pending 待处理 / extracting 提取中 / ready 可用 / failed 失败
  glossary: GlossaryMemoryItem[];
  style_tags: StyleMemoryItem[];
  global_settings: GlobalSettingMemoryItem[];
  source_chunk_hashes: string[];
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
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
/**
 * 从文档中提取的术语表 风格标签 全局设置
 */
export interface ExtractedDocumentMemory {
  /**
   * 从文档中提取的词汇表项
   */
  glossary: Array<{
    term: string;
    definition: string;
    aliases?: string[];
    evidence_hashes?: string[];
    confidence: number;
  }>;
  /**
   * 从文档中提取的风格标签
   */
  style_tags: Array<{
    label: string;
    instruction: string;
    evidence_hashes?: string[];
    confidence: number;
  }>;
  /**
   * 从文档中提取的全局设置
   */
  global_settings: Array<{
    key: string;
    value: string;
    evidence_hashes?: string[];
    confidence: number;
  }>;
}
