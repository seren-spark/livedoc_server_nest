/**
 * @file 文档记忆存储。读写文档的自动记忆项、状态和来源信息。
 */
import { DatabaseService } from '../../database/database.service.js';
import type {
  DocumentMemoryProfile,
  GlobalSettingMemoryItem,
  GlossaryMemoryItem,
  StyleMemoryItem,
} from './document-memory.types.js';

const PROFILE_COLUMNS = `doc_id,space_id,source_document_version,status,glossary,
  style_tags,global_settings,source_chunk_hashes,last_error,created_at,updated_at`;

export class DocumentMemoryRepository {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 按文档标识读取其记忆记录。
   *
   * @param docId 知识文档标识。
   * @returns 文档记忆档案；未找到或不可用时可能为空。
   */
  async findByDocumentId(docId: string): Promise<DocumentMemoryProfile | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM document_memory_profiles WHERE doc_id=?`,
      [docId],
    );
    return rows[0] ? mapProfile(rows[0]) : null;
  }

  /**
   * 保存文档记忆的当前数据。
   *
   * @param profile 模型配置或文档记忆档案。
   */
  async save(profile: DocumentMemoryProfile): Promise<void> {
    await this.database.query(
      `INSERT INTO document_memory_profiles
        (${PROFILE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        source_document_version=VALUES(source_document_version),
        status=VALUES(status),glossary=VALUES(glossary),
        style_tags=VALUES(style_tags),global_settings=VALUES(global_settings),
        source_chunk_hashes=VALUES(source_chunk_hashes),
        last_error=VALUES(last_error),updated_at=VALUES(updated_at)`,
      [
        profile.doc_id,
        profile.space_id,
        profile.source_document_version,
        profile.status,
        JSON.stringify(profile.glossary),
        JSON.stringify(profile.style_tags),
        JSON.stringify(profile.global_settings),
        JSON.stringify(profile.source_chunk_hashes),
        profile.last_error,
        profile.created_at,
        profile.updated_at,
      ],
    );
  }

  /**
   * 删除指定文档记忆。
   *
   * @param docId 知识文档标识。
   */
  async delete(docId: string): Promise<void> {
    await this.database.query('DELETE FROM document_memory_profiles WHERE doc_id=?', [docId]);
  }
}

/**
 * 把数据库记录转换为文档记忆档案。
 *
 * @param row 数据库查询返回的一行数据。
 * @returns 文档记忆档案。
 */
function mapProfile(row: Record<string, unknown>): DocumentMemoryProfile {
  return {
    doc_id: String(row.doc_id),
    space_id: String(row.space_id),
    source_document_version: Number(row.source_document_version),
    status: row.status as DocumentMemoryProfile['status'],
    glossary: parseAutomaticItems<GlossaryMemoryItem>(row.glossary),
    style_tags: parseAutomaticItems<StyleMemoryItem>(row.style_tags),
    global_settings: parseAutomaticItems<GlobalSettingMemoryItem>(row.global_settings),
    source_chunk_hashes: parseArray<string>(row.source_chunk_hashes),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_at: new Date(row.created_at as string | Date),
    updated_at: new Date(row.updated_at as string | Date),
  };
}

/**
 * 将存储的 JSON 数组解析为业务数据。
 *
 * @param value 待校验或转换的值。
 * @returns 整理后的结果列表。
 */
function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

/**
 * 解析自动提取的记忆项及其来源证据。
 *
 * @param value 待校验或转换的值。
 * @returns 整理后的结果列表。
 */
function parseAutomaticItems<T>(value: unknown): T[] {
  return parseArray<Record<string, unknown>>(value)
    .filter((item) => item.origin !== 'user')
    .map(({ origin: _origin, pinned: _pinned, ...item }) => item as T);
}
