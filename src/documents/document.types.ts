import type { IndexStatus, SourceType, Visibility } from "../common/types.js";

export interface DocumentRecord {
  category_id?: string | null;
  deleted_at?: Date | null;
  delete_batch_id?: string | null;
  doc_id: string; // 文档主键，也是 Qdrant payload 的 doc_id。
  space_id: string; // 用户空间隔离键。
  title: string; // 文档标题，会进入 embedding passage。
  content: string; // 已确认 Markdown 正文。
  visibility: Visibility; // private/team/public。
  source_type: SourceType; // note/team_doc/public_article 等。
  tags: string[]; // 检索过滤和页面分类标签。
  team_id: string | null; // team 文档的团队 id。
  owner_id: string | null; // private 权限过滤使用。
  url: string | null; // 外部文章来源地址。
  editor_content: Record<string, unknown> | null; // TipTap JSON。
  source_import_id: string | null; // PDF/DOCX 来源；手动文档通常为空。
  assets?: unknown[]; // 对外响应中附带的图片/源文件资产。
  document_version: number; // 每次成功更新递增。
  index_status: IndexStatus; // pending/queued/indexing/ready/failed。
  active_index_version: number | null; // 当前可被检索的版本。
  latest_index_job_id: string | null; // 最近索引任务 id。
  chunk_count: number; // active 版本切片数量。
  indexed_at: Date | null; // 最近成功激活索引的时间。
  index_error: string | null; // 最新索引失败原因。
  created_at: Date; // 文档创建时间。
  updated_at: Date; // 文档内容/状态更新时间。
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

/**
 * 将 DocumentRecord 转换为 DocumentIndexRequest
 * 供 Worker 异步执行分块、向量化时使用。
 * @param record - DocumentRecord
 * @returns DocumentIndexRequest
 */
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
