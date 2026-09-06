import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DocumentCreateDto, DocumentUpdateDto } from '../common/dto.js';
import type { AccessContext, IndexStatus, Visibility } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import type { DocumentRecord } from './document.types.js';
import { DocumentsRepository } from './documents.repository.js';

@Injectable()
export class DocumentsService {
  private readonly records = new Map<string, DocumentRecord>();
  private readonly repository: DocumentsRepository;

  constructor(private readonly database: DatabaseService) {
    this.repository = new DocumentsRepository(database);
  }

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
      owner_id: context.user_id,
      url: request.url ?? null,
      editor_content: request.editor_content ?? null,
      source_import_id: request.source_import_id ?? null,
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
      await this.repository.insert(record);
    } else {
      if (this.records.has(record.doc_id)) throw new Error(`Duplicate document: ${record.doc_id}`);
      this.records.set(record.doc_id, record);
    }
    return record;
  }

  async list(
    context: AccessContext,
    page: number,
    pageSize: number,
    filters: { q?: string; visibility?: Visibility; source_type?: string; tag?: string; team_id?: string; index_status?: IndexStatus } = {},
  ): Promise<{ items: DocumentRecord[]; total: number }> {
    let visible: DocumentRecord[];
    if (this.database.metadataEnabled) {
      return this.repository.list(context, page, pageSize, filters);
    } else {
      visible = [...this.records.values()].filter((record) => canAccessDocument(record, context));
      const query = filters.q?.trim().toLocaleLowerCase();
      if (query) visible = visible.filter((record) => `${record.title}\n${record.content}`.toLocaleLowerCase().includes(query));
      if (filters.visibility) visible = visible.filter((record) => record.visibility === filters.visibility);
      if (filters.source_type) visible = visible.filter((record) => record.source_type === filters.source_type);
      if (filters.tag?.trim()) visible = visible.filter((record) => record.tags.includes(filters.tag!.trim()));
      if (filters.team_id?.trim()) visible = visible.filter((record) => record.team_id === filters.team_id!.trim());
      if (filters.index_status) visible = visible.filter((record) => record.index_status === filters.index_status);
      visible.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
    }
    const total = visible.length;
    const offset = (page - 1) * pageSize;
    return { items: visible.slice(offset, offset + pageSize), total };
  }

  async listPublicArticles(
    page: number,
    pageSize: number,
    filters: { q?: string } = {},
  ): Promise<{ items: DocumentRecord[]; total: number }> {
    if (this.database.metadataEnabled) {
      return this.repository.listPublic(page, pageSize, filters.q);
    }

    let visible = [...this.records.values()].filter(
      (record) =>
        record.visibility === 'public' &&
        ['public_article', 'article'].includes(record.source_type),
    );
    const query = filters.q?.trim().toLocaleLowerCase();
    if (query) {
      visible = visible.filter((record) =>
        `${record.title}\n${record.content}`.toLocaleLowerCase().includes(query),
      );
    }
    visible.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
    const total = visible.length;
    const offset = (page - 1) * pageSize;
    return { items: visible.slice(offset, offset + pageSize), total };
  }

  async getPublicArticle(docId: string): Promise<DocumentRecord> {
    const record = await this.require(docId);
    if (
      record.visibility !== 'public' ||
      !['public_article', 'article'].includes(record.source_type)
    ) {
      throw new NotFoundException('Public article not found.');
    }
    return record;
  }

  async get(docId: string): Promise<DocumentRecord | null> {
    if (!this.database.metadataEnabled) return this.records.get(docId) ?? null;
    return this.repository.findById(docId);
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

  async getWritable(docId: string, context: AccessContext): Promise<DocumentRecord> {
    const record = await this.require(docId);
    const allowed = record.space_id === context.space_id && (
      record.owner_id === context.user_id ||
      (record.visibility === 'team' && Boolean(record.team_id && context.team_ids.includes(record.team_id)))
    );
    if (!allowed) throw new ForbiddenException('Document write access denied.');
    return record;
  }

  async update(docId: string, request: DocumentUpdateDto, context: AccessContext): Promise<DocumentRecord> {
    const current = await this.getWritable(docId, context);
    if (request.expected_version !== undefined && request.expected_version !== current.document_version) {
      throw new ConflictException({
        code: 'DOCUMENT_VERSION_CONFLICT',
        message: 'Document has been updated by another session.',
        current_version: current.document_version,
      });
    }
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
    const { asset_ids: _assetIds, expected_version: _expectedVersion, ...documentPatch } = request;
    const next: DocumentRecord = {
      ...current,
      ...defined(documentPatch),
      team_id: nextTeamId ?? null,
      owner_id: current.owner_id ?? context.user_id,
      document_version: indexedChanged ? current.document_version + 1 : current.document_version,
      index_status: indexedChanged ? 'pending' : current.index_status,
      active_index_version: accessChanged ? null : current.active_index_version,
      latest_index_job_id: indexedChanged ? null : current.latest_index_job_id,
      index_error: indexedChanged ? null : current.index_error,
      updated_at: new Date(),
      editor_content: request.editor_content === undefined ? current.editor_content : request.editor_content,
    };
    if (this.database.metadataEnabled) {
      if (!(await this.repository.update(next, current.document_version))) {
        throw new ConflictException({
          code: 'DOCUMENT_VERSION_CONFLICT',
          message: 'Document changed while saving. Reload and retry.',
        });
      }
    } else this.records.set(docId, next);
    return next;
  }

  async delete(docId: string, context: AccessContext): Promise<void> {
    await this.getWritable(docId, context);
    if (this.database.metadataEnabled) await this.repository.delete(docId);
    else this.records.delete(docId);
  }
/**
   * 把文档标记为“已进入索引队列”状态 ，让前端轮询时能看到文档正在排队索引
   * @param docId 文档 ID
   * @param jobId 索引任务 ID
   */
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

  /**
   * 团队写入权限闸门 ：当文档可见性为 team 时，必须指定一个有效的 team_id ，且当前用户必须属于这个团队，否则拒绝创建/更新。
   */
  assertTeamTarget(visibility: Visibility, teamId: string | null | undefined, context: AccessContext): void {
    if (visibility === 'team' && (!teamId || !context.team_ids.includes(teamId))) {
      throw new ForbiddenException('Cannot write document into another team.');
    }
  }

  private async patchState(docId: string, patch: Partial<DocumentRecord>): Promise<void> {
    const current = await this.require(docId);
    const next = { ...current, ...patch };
    if (this.database.metadataEnabled) {
      await this.repository.updateIndexState(next);
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
