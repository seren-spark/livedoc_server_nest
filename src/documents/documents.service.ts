import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DocumentCreateDto, DocumentUpdateDto } from '../common/dto.js';
import type { AccessContext, Visibility } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import type { DocumentRecord } from './document.types.js';

@Injectable()
export class DocumentsService {
  private readonly records = new Map<string, DocumentRecord>();

  constructor(private readonly database: DatabaseService) {}

  async create(request: DocumentCreateDto, context: AccessContext): Promise<DocumentRecord> {
    this.assertTeamTarget(request.visibility, request.team_id, context);
    const now = new Date();
    const record: DocumentRecord = {
      doc_id: request.doc_id ?? randomUUID().replaceAll('-', ''),
      space_id: context.space_id,
      title: request.title,
      content: request.content,
      visibility: request.visibility,
      source_type: request.source_type,
      tags: [...request.tags],
      team_id: request.team_id ?? null,
      owner_id: request.visibility === 'private' ? context.user_id : null,
      url: request.url ?? null,
      document_version: 1,
      index_status: 'pending',
      active_index_version: null,
      latest_index_job_id: null,
      chunk_count: 0,
      indexed_at: null,
      index_error: null,
      created_at: now,
      updated_at: now,
    };
    if (this.database.metadataEnabled) {
      await this.database.query(
        `INSERT INTO knowledge_documents
          (doc_id, space_id, title, content, visibility, source_type, tags, team_id,
           owner_id, url, document_version, index_status, chunk_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, ?, ?)`,
        [
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
          now,
          now,
        ],
      );
    } else {
      if (this.records.has(record.doc_id)) throw new Error(`Duplicate document: ${record.doc_id}`);
      this.records.set(record.doc_id, record);
    }
    return record;
  }

  async list(context: AccessContext, page: number, pageSize: number): Promise<{ items: DocumentRecord[]; total: number }> {
    let visible: DocumentRecord[];
    if (this.database.metadataEnabled) {
      const teamPlaceholders = context.team_ids.map(() => '?').join(',');
      const teamClause = context.team_ids.length
        ? `(visibility = 'team' AND space_id = ? AND team_id IN (${teamPlaceholders}))`
        : 'FALSE';
      const params: unknown[] = [context.space_id, context.user_id, context.space_id, ...context.team_ids];
      visible = (
        await this.database.query<Record<string, unknown>>(
          `SELECT * FROM knowledge_documents WHERE
           (visibility = 'private' AND space_id = ? AND owner_id = ?)
           OR ${teamClause} OR visibility = 'public'
           ORDER BY updated_at DESC`,
          params,
        )
      ).map(mapDocumentRow);
    } else {
      visible = [...this.records.values()].filter((record) => canAccessDocument(record, context));
      visible.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
    }
    const total = visible.length;
    const offset = (page - 1) * pageSize;
    return { items: visible.slice(offset, offset + pageSize), total };
  }

  async get(docId: string): Promise<DocumentRecord | null> {
    if (!this.database.metadataEnabled) return this.records.get(docId) ?? null;
    const rows = await this.database.query<Record<string, unknown>>(
      'SELECT * FROM knowledge_documents WHERE doc_id = ?',
      [docId],
    );
    return rows[0] ? mapDocumentRow(rows[0]) : null;
  }

  async require(docId: string): Promise<DocumentRecord> {
    const record = await this.get(docId);
    if (!record) throw new NotFoundException('Document not found.');
    return record;
  }

  async getAccessible(docId: string, context: AccessContext): Promise<DocumentRecord> {
    const record = await this.require(docId);
    this.assertAccess(record, context);
    return record;
  }

  async update(docId: string, request: DocumentUpdateDto, context: AccessContext): Promise<DocumentRecord> {
    const current = await this.getAccessible(docId, context);
    const nextVisibility = request.visibility ?? current.visibility;
    const nextTeamId = request.team_id !== undefined ? request.team_id : current.team_id;
    this.assertTeamTarget(nextVisibility, nextTeamId, context);
    const indexedChanged =
      (request.title !== undefined && request.title !== current.title) ||
      (request.content !== undefined && request.content !== current.content) ||
      (request.visibility !== undefined && request.visibility !== current.visibility) ||
      (request.source_type !== undefined && request.source_type !== current.source_type) ||
      (request.tags !== undefined && JSON.stringify(request.tags) !== JSON.stringify(current.tags)) ||
      (request.team_id !== undefined && request.team_id !== current.team_id) ||
      (request.url !== undefined && request.url !== current.url);
    const accessChanged =
      (request.visibility !== undefined && request.visibility !== current.visibility) ||
      (request.team_id !== undefined && request.team_id !== current.team_id);
    const next: DocumentRecord = {
      ...current,
      ...defined(request),
      team_id: nextTeamId ?? null,
      owner_id: nextVisibility === 'private' ? context.user_id : null,
      document_version: indexedChanged ? current.document_version + 1 : current.document_version,
      index_status: indexedChanged ? 'pending' : current.index_status,
      active_index_version: accessChanged ? null : current.active_index_version,
      latest_index_job_id: indexedChanged ? null : current.latest_index_job_id,
      index_error: indexedChanged ? null : current.index_error,
      updated_at: new Date(),
    };
    if (this.database.metadataEnabled) {
      await this.database.query(
        `UPDATE knowledge_documents SET title=?, content=?, visibility=?, source_type=?, tags=?,
         team_id=?, owner_id=?, url=?, document_version=?, index_status=?, active_index_version=?,
         latest_index_job_id=?, index_error=?, updated_at=?
         WHERE doc_id=?`,
        [
          next.title,
          next.content,
          next.visibility,
          next.source_type,
          JSON.stringify(next.tags),
          next.team_id,
          next.owner_id,
          next.url,
          next.document_version,
          next.index_status,
          next.active_index_version,
          next.latest_index_job_id,
          next.index_error,
          next.updated_at,
          docId,
        ],
      );
    } else this.records.set(docId, next);
    return next;
  }

  async delete(docId: string, context: AccessContext): Promise<void> {
    await this.getAccessible(docId, context);
    if (this.database.metadataEnabled) await this.database.query('DELETE FROM knowledge_documents WHERE doc_id = ?', [docId]);
    else this.records.delete(docId);
  }

  async markQueued(docId: string, jobId: string): Promise<void> {
    await this.patchState(docId, {
      index_status: 'queued',
      latest_index_job_id: jobId,
      index_error: null,
      updated_at: new Date(),
    });
  }

  async markIndexing(docId: string): Promise<void> {
    await this.patchState(docId, { index_status: 'indexing', index_error: null, updated_at: new Date() });
  }

  async markReady(docId: string, chunkCount: number, version: number): Promise<void> {
    await this.patchState(docId, {
      index_status: 'ready',
      active_index_version: version,
      chunk_count: chunkCount,
      indexed_at: new Date(),
      index_error: null,
      updated_at: new Date(),
    });
  }

  async markFailed(docId: string, error: string): Promise<void> {
    await this.patchState(docId, { index_status: 'failed', index_error: error.slice(0, 2000), updated_at: new Date() });
  }

  assertAccess(record: DocumentRecord, context: AccessContext): void {
    if (!canAccessDocument(record, context)) throw new ForbiddenException('Document access denied.');
  }

  assertTeamTarget(visibility: Visibility, teamId: string | null | undefined, context: AccessContext): void {
    if (visibility === 'team' && (!teamId || !context.team_ids.includes(teamId))) {
      throw new ForbiddenException('Cannot write document into another team.');
    }
  }

  private async patchState(docId: string, patch: Partial<DocumentRecord>): Promise<void> {
    const current = await this.require(docId);
    const next = { ...current, ...patch };
    if (this.database.metadataEnabled) {
      await this.database.query(
        `UPDATE knowledge_documents SET index_status=?, active_index_version=?, latest_index_job_id=?,
         chunk_count=?, indexed_at=?, index_error=?, updated_at=? WHERE doc_id=?`,
        [
          next.index_status,
          next.active_index_version,
          next.latest_index_job_id,
          next.chunk_count,
          next.indexed_at,
          next.index_error,
          next.updated_at,
          docId,
        ],
      );
    } else this.records.set(docId, next);
  }
}

export function canAccessDocument(record: DocumentRecord, context: AccessContext): boolean {
  if (record.visibility === 'public') return true;
  if (record.space_id !== context.space_id) return false;
  if (record.visibility === 'private') return record.owner_id === context.user_id;
  return Boolean(record.team_id && context.team_ids.includes(record.team_id));
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapDocumentRow(row: Record<string, unknown>): DocumentRecord {
  return {
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
