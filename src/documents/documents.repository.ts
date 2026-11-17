/**
 * @file 知识文档存储。读写文档正文与版本快照，分页筛选列表并维护索引状态。
 */
import type { AccessContext, IndexStatus, KnowledgeScope, Visibility } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import type { DocumentRecord } from './document.types.js';
import type { EntityManager } from 'typeorm';

export interface DocumentListFilters {
  category_id?: string;
  q?: string;
  visibility?: Visibility;
  source_type?: string;
  tag?: string;
  team_id?: string;
  index_status?: IndexStatus;
}
export type KnowledgeDocumentVersion = Pick<DocumentRecord,
  'doc_id' | 'title' | 'document_version' | 'active_index_version' | 'visibility' | 'team_id'>;

const DOCUMENT_COLUMNS = `category_id,deleted_at,delete_batch_id,doc_id,space_id,title,content,visibility,source_type,tags,team_id,
  owner_id,url,editor_content,source_import_id,document_version,index_status,
  active_index_version,latest_index_job_id,chunk_count,indexed_at,index_error,created_at,updated_at`;

export class DocumentsRepository {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 读取知识范围中有效文档的版本信息。
   *
   * @param scope 本次检索或操作允许覆盖的范围。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的结果列表。
   */
  async knowledgeVersions(scope: KnowledgeScope, context: AccessContext): Promise<KnowledgeDocumentVersion[]> {
    const domains: string[] = [];
    const params: unknown[] = [];
    if (scope.private) {
      domains.push("(d.visibility='private' AND d.space_id=? AND d.owner_id=?)");
      params.push(context.space_id, context.user_id);
    }
    if (scope.team && context.team_ids.length) {
      domains.push(`(d.visibility='team' AND d.space_id=? AND d.team_id IN (${context.team_ids.map(() => '?').join(',')}))`);
      params.push(context.space_id, ...context.team_ids);
    }
    if (scope.public) domains.push("d.visibility='public'");
    if (!domains.length) return [];
    let ids = '';
    if (scope.document_ids.length) {
      ids = ` AND d.doc_id IN (${scope.document_ids.map(() => '?').join(',')})`;
      params.push(...scope.document_ids);
    }
    return this.database.query<KnowledgeDocumentVersion>(
      `SELECT d.doc_id,d.title,d.document_version,d.active_index_version,d.visibility,d.team_id
       FROM knowledge_documents d WHERE d.deleted_at IS NULL AND (${domains.join(' OR ')})${ids}
       AND NOT EXISTS (SELECT 1 FROM article_drafts a WHERE a.article_id=d.doc_id AND a.state<>'published')`,
      params,
    );
  }

  /**
   * 保存当前文档版本的内容快照。
   *
   * @param record 当前知识文档记录。
   * @param manager 当前数据库事务执行器。
   */
  async saveSnapshot(record: DocumentRecord, manager: EntityManager): Promise<void> {
    await manager.query(`INSERT INTO knowledge_documents
      (doc_id,space_id,title,content,visibility,source_type,tags,team_id,owner_id,url,editor_content,source_import_id,
       document_version,index_status,active_index_version,latest_index_job_id,chunk_count,indexed_at,index_error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
      title=VALUES(title),content=VALUES(content),visibility=VALUES(visibility),tags=VALUES(tags),url=VALUES(url),
      editor_content=VALUES(editor_content),document_version=VALUES(document_version),index_status=VALUES(index_status),
      active_index_version=VALUES(active_index_version),latest_index_job_id=VALUES(latest_index_job_id),
      chunk_count=VALUES(chunk_count),indexed_at=VALUES(indexed_at),index_error=VALUES(index_error),updated_at=VALUES(updated_at)`,
      [record.doc_id,record.space_id,record.title,record.content,record.visibility,record.source_type,JSON.stringify(record.tags),
        record.team_id,record.owner_id,record.url,record.editor_content ? JSON.stringify(record.editor_content) : null,record.source_import_id,
        record.document_version,record.index_status,record.active_index_version,record.latest_index_job_id,record.chunk_count,
        record.indexed_at,record.index_error,record.created_at,record.updated_at]);
  }

  /**
   * 向存储写入新的知识文档。
   *
   * @param record 当前知识文档记录。
   */
  async insert(record: DocumentRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO knowledge_documents
        (doc_id,space_id,title,content,visibility,source_type,tags,team_id,
         owner_id,url,editor_content,source_import_id,document_version,index_status,
         chunk_count,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'pending',0,?,?)`,
      documentInsertValues(record),
    );
  }

  /**
   * 按查询条件读取知识文档列表。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param page 当前页码或页面记录。
   * @param pageSize 每页返回的条目数。
   * @param filters 查询列表时使用的筛选条件。
   * @returns 当前页条目与符合条件的总数。
   */
  async list(
    context: AccessContext,
    page: number,
    pageSize: number,
    filters: DocumentListFilters,
  ): Promise<{ items: DocumentRecord[]; total: number }> {
    const teamPlaceholders = context.team_ids.map(() => '?').join(',');
    const teamClause = context.team_ids.length
      ? `(visibility='team' AND space_id=? AND team_id IN (${teamPlaceholders}))`
      : 'FALSE';
    const clauses = [
      'deleted_at IS NULL',
      `((visibility='private' AND space_id=? AND owner_id=?) OR ${teamClause} OR visibility='public')`,
      'NOT EXISTS (SELECT 1 FROM article_drafts a WHERE a.article_id=knowledge_documents.doc_id)',
    ];
    const params: unknown[] = [
      context.space_id,
      context.user_id,
      ...(context.team_ids.length ? [context.space_id, ...context.team_ids] : []),
    ];
    appendFilters(clauses, params, filters);
    return this.page(clauses.join(' AND '), params, page, pageSize);
  }

  /**
   * 按筛选条件分页读取公开文档。
   *
   * @param page 当前页码或页面记录。
   * @param pageSize 每页返回的条目数。
   * @param query 用户问题或检索查询（可选）。
   * @returns 当前页条目与符合条件的总数。
   */
  async listPublic(
    page: number,
    pageSize: number,
    query?: string,
  ): Promise<{ items: DocumentRecord[]; total: number }> {
    const clauses = ['deleted_at IS NULL', "visibility='public'", "source_type IN ('public_article','article')",
      "NOT EXISTS (SELECT 1 FROM article_drafts a WHERE a.article_id=knowledge_documents.doc_id AND a.state<>'published')"];
    const params: unknown[] = [];
    if (query?.trim()) {
      clauses.push('(title LIKE ? OR content LIKE ?)');
      const like = `%${query.trim()}%`;
      params.push(like, like);
    }
    return this.page(clauses.join(' AND '), params, page, pageSize,
      '(SELECT a.published_at FROM article_drafts a WHERE a.article_id=knowledge_documents.doc_id)');
  }

  /**
   * 按唯一标识读取存储记录。
   *
   * @param docId 知识文档标识。
   * @returns 知识文档记录；未找到或不可用时可能为空。
   */
  async findById(docId: string): Promise<DocumentRecord | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE doc_id=?`,
      [docId],
    );
    return rows[0] ? mapDocumentRow(rows[0]) : null;
  }

  /**
   * 根据请求更新知识文档。
   *
   * @param next 当前知识文档记录。
   * @param expectedVersion 调用方期望操作的内容版本。
   * @returns 条件是否满足的判断结果。
   */
  async update(next: DocumentRecord, expectedVersion: number): Promise<boolean> {
    const result = await this.database.source.query(
      `UPDATE knowledge_documents SET title=?,content=?,visibility=?,source_type=?,tags=?,
       team_id=?,owner_id=?,url=?,editor_content=?,document_version=?,index_status=?,active_index_version=?,
       latest_index_job_id=?,index_error=?,updated_at=?,category_id=IF(?='private',category_id,NULL) WHERE doc_id=? AND document_version=? AND deleted_at IS NULL`,
      [
        next.title,
        next.content,
        next.visibility,
        next.source_type,
        JSON.stringify(next.tags),
        next.team_id,
        next.owner_id,
        next.url,
        next.editor_content == null ? null : JSON.stringify(next.editor_content),
        next.document_version,
        next.index_status,
        next.active_index_version,
        next.latest_index_job_id,
        next.index_error,
        next.updated_at,
        next.visibility,
        next.doc_id,
        expectedVersion,
      ],
    );
    return Number(result?.affectedRows ?? 0) === 1;
  }

  /**
   * 删除指定知识文档。
   *
   * @param docId 知识文档标识。
   */
  async delete(docId: string): Promise<void> {
    await this.database.query('DELETE FROM knowledge_documents WHERE doc_id=?', [docId]);
  }

  /**
   * 更新文档的索引状态、版本与任务关联。
   *
   * @param record 当前知识文档记录。
   * @param version 本次操作对应的内容版本（可选）。
   */
  async updateIndexState(record: DocumentRecord, version?: number): Promise<void> {
    await this.database.query(
      `UPDATE knowledge_documents SET index_status=?,active_index_version=?,latest_index_job_id=?,
       chunk_count=?,indexed_at=?,index_error=?,updated_at=? WHERE doc_id=?${version === undefined ? '' : ' AND document_version=?'}`,
      [
        record.index_status,
        record.active_index_version,
        record.latest_index_job_id,
        record.chunk_count,
        record.indexed_at,
        record.index_error,
        record.updated_at,
        record.doc_id,
        ...(version === undefined ? [] : [version]),
      ],
    );
  }

  /**
   * 从查询结果中整理分页条目和总数。
   *
   * @param where 查询或清理使用的筛选条件。
   * @param params 查询或调用所需的绑定参数。
   * @param page 当前页码或页面记录。
   * @param pageSize 每页返回的条目数。
   * @param publishedOrder 公开条目需要遵守的展示顺序（可选）。
   * @returns 当前页条目与符合条件的总数。
   */
  private async page(
    where: string,
    params: unknown[],
    page: number,
    pageSize: number,
    publishedOrder?: string,
  ): Promise<{ items: DocumentRecord[]; total: number }> {
    const countRows = await this.database.query<{ total: number | string }>(
      `SELECT COUNT(*) AS total FROM knowledge_documents WHERE ${where}`,
      params,
    );
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE ${where}
       ORDER BY ${publishedOrder ? `COALESCE(${publishedOrder},created_at)` : 'updated_at'} DESC, doc_id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return {
      items: rows.map(mapDocumentRow),
      total: Number(countRows[0]?.total ?? 0),
    };
  }
}

/**
 * 向数据库查询追加文档筛选条件与绑定参数。
 *
 * @param clauses 需要组合的 SQL 条件片段。
 * @param params 查询或调用所需的绑定参数。
 * @param filters 查询列表时使用的筛选条件。
 */
function appendFilters(
  clauses: string[],
  params: unknown[],
  filters: DocumentListFilters,
): void {
  if (filters.category_id === '__uncategorized__') clauses.push('category_id IS NULL');
  else if(filters.category_id) {clauses.push('category_id=?');params.push(filters.category_id);}
  if (filters.q?.trim()) {
    clauses.push('(title LIKE ? OR content LIKE ?)');
    const like = `%${filters.q.trim()}%`;
    params.push(like, like);
  }
  const equals: Array<[unknown, string]> = [
    [filters.visibility, 'visibility'],
    [filters.source_type, 'source_type'],
    [filters.team_id?.trim(), 'team_id'],
    [filters.index_status, 'index_status'],
  ];
  for (const [value, column] of equals) {
    if (value) {
      clauses.push(`${column}=?`);
      params.push(value);
    }
  }
  if (filters.tag?.trim()) {
    clauses.push('JSON_CONTAINS(tags,JSON_QUOTE(?))');
    params.push(filters.tag.trim());
  }
}

/**
 * 按插入列的顺序整理文档字段值。
 *
 * @param record 当前知识文档记录。
 * @returns 整理后的结果列表。
 */
function documentInsertValues(record: DocumentRecord): unknown[] {
  return [
    record.doc_id,
    record.space_id,
    record.title,
    record.content,
    record.visibility,
    record.source_type,
    JSON.stringify(record.tags),
    record.team_id,
    record.owner_id,
    record.url,
    record.editor_content == null ? null : JSON.stringify(record.editor_content),
    record.source_import_id,
    record.created_at,
    record.updated_at,
  ];
}

/**
 * 将数据库行转换为知识文档业务记录。
 *
 * @param row 数据库查询返回的一行数据。
 * @returns 知识文档记录。
 */
export function mapDocumentRow(row: Record<string, unknown>): DocumentRecord {
  return {
    category_id: row.category_id == null ? null : String(row.category_id),
    deleted_at: row.deleted_at == null ? null : new Date(row.deleted_at as string),
    delete_batch_id: row.delete_batch_id == null ? null : String(row.delete_batch_id),
    doc_id: String(row.doc_id),
    space_id: String(row.space_id),
    title: String(row.title),
    content: String(row.content),
    visibility: row.visibility as DocumentRecord['visibility'],
    source_type: row.source_type as DocumentRecord['source_type'],
    tags: parseTags(row.tags),
    team_id: row.team_id == null ? null : String(row.team_id),
    owner_id: row.owner_id == null ? null : String(row.owner_id),
    url: row.url == null ? null : String(row.url),
    editor_content: parseObject(row.editor_content),
    source_import_id: row.source_import_id == null ? null : String(row.source_import_id),
    document_version: Number(row.document_version),
    index_status: row.index_status as DocumentRecord['index_status'],
    active_index_version: row.active_index_version == null ? null : Number(row.active_index_version),
    latest_index_job_id: row.latest_index_job_id == null ? null : String(row.latest_index_job_id),
    chunk_count: Number(row.chunk_count),
    indexed_at: row.indexed_at == null ? null : new Date(row.indexed_at as string | number | Date),
    index_error: row.index_error == null ? null : String(row.index_error),
    created_at: new Date(row.created_at as string | number | Date),
    updated_at: new Date(row.updated_at as string | number | Date),
  };
}

/**
 * 解析标签字段，转换为业务使用的字符串数组。
 *
 * @param value 待校验或转换的值。
 * @returns 整理后的字符串列表。
 */
function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 将 JSON 存储值还原为对象。
 *
 * @param value 待校验或转换的值。
 * @returns Record<string, unknown> 类型的处理结果；未找到或不可用时可能为空。
 */
function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
