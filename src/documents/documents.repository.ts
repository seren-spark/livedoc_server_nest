import type { AccessContext, IndexStatus, Visibility } from '../common/types.js';
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

const DOCUMENT_COLUMNS = `category_id,deleted_at,delete_batch_id,doc_id,space_id,title,content,visibility,source_type,tags,team_id,
  owner_id,url,editor_content,source_import_id,document_version,index_status,
  active_index_version,latest_index_job_id,chunk_count,indexed_at,index_error,created_at,updated_at`;

export class DocumentsRepository {
  constructor(private readonly database: DatabaseService) {}

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

  async findById(docId: string): Promise<DocumentRecord | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE doc_id=?`,
      [docId],
    );
    return rows[0] ? mapDocumentRow(rows[0]) : null;
  }

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

  async delete(docId: string): Promise<void> {
    await this.database.query('DELETE FROM knowledge_documents WHERE doc_id=?', [docId]);
  }

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
