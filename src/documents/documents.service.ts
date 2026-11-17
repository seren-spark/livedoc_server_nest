/**
 * @file 知识文档生命周期。处理创建、读取、权限校验、版本更新、删除和索引状态切换。
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { DocumentCreateDto, DocumentUpdateDto } from '../common/dto.js';
import type { AccessContext, IndexStatus, KnowledgeScope, Visibility } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import type { DocumentRecord } from './document.types.js';
import { DocumentsRepository, mapDocumentRow, type KnowledgeDocumentVersion } from './documents.repository.js';
import { ArticleRepository } from '../articles/article.repository.js';
import { ArticleInteractionsRepository } from '../articles/article-interactions.repository.js';
import { DocumentCatalog } from '../database/document-catalog.js';
import { canAccessDocument } from './document-access.js';
export { canAccessDocument } from './document-access.js';

@Injectable()
export class DocumentsService {
  private readonly records = new Map<string, DocumentRecord>();
  private readonly lifecycleWrites = new Map<string, Promise<unknown>>();
  private readonly repository: DocumentsRepository;

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   * @param articles ArticleRepository 依赖实例（可选）。
   * @param interactions ArticleInteractionsRepository 依赖实例（可选）。
   * @param catalog 当前可用文档、技能或来源目录（可选）。
   */
  constructor(private readonly database: DatabaseService, @Optional() private readonly articles?: ArticleRepository,
    @Optional() private readonly interactions?: ArticleInteractionsRepository,
    @Optional() private readonly catalog?:DocumentCatalog) {
    this.repository = new DocumentsRepository(database);
    if(catalog) this.records=catalog.records;
  }

  /**
   * 根据输入创建知识文档并返回结果。
   *
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 知识文档记录。
   */
  async create(request: DocumentCreateDto, context: AccessContext): Promise<DocumentRecord> {
    if (request.doc_id?.startsWith('wiki_')) throw new BadRequestException('wiki_ 文档标识由知识沉淀服务管理');
    if (request.doc_id) await this.assertUnmanaged(request.doc_id);
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
    filters: { q?: string; visibility?: Visibility; source_type?: string; tag?: string; team_id?: string; index_status?: IndexStatus; category_id?:string } = {},
  ): Promise<{ items: DocumentRecord[]; total: number }> {
    let visible: DocumentRecord[];
    if (this.database.metadataEnabled) {
      return this.repository.list(context, page, pageSize, filters);
    } else {
      visible = [...this.records.values()].filter((record) => canAccessDocument(record, context) && !this.articles?.records.has(record.doc_id));
      const query = filters.q?.trim().toLocaleLowerCase();
      if (query) visible = visible.filter((record) => `${record.title}\n${record.content}`.toLocaleLowerCase().includes(query));
      if (filters.visibility) visible = visible.filter((record) => record.visibility === filters.visibility);
      if (filters.source_type) visible = visible.filter((record) => record.source_type === filters.source_type);
      if (filters.tag?.trim()) visible = visible.filter((record) => record.tags.includes(filters.tag!.trim()));
      if (filters.team_id?.trim()) visible = visible.filter((record) => record.team_id === filters.team_id!.trim());
      if (filters.index_status) visible = visible.filter((record) => record.index_status === filters.index_status);
      if (filters.category_id) visible = visible.filter(record => filters.category_id==='__uncategorized__'?!record.category_id:record.category_id===filters.category_id);
      visible.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
    }
    const total = visible.length;
    const offset = (page - 1) * pageSize;
    return { items: visible.slice(offset, offset + pageSize), total };
  }

  /**
   * 对当前知识范围中的文档版本生成指纹，检测来源变化。
   *
   * @param scope 本次检索或操作允许覆盖的范围。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的文本或标识。
   */
  async knowledgeFingerprint(scope: KnowledgeScope, context: AccessContext): Promise<string> {
    // Metadata only: no document bodies or model calls are needed to detect range changes.
    const rows: KnowledgeDocumentVersion[] = this.database.metadataEnabled
      ? await this.repository.knowledgeVersions(scope, context)
      : [...this.records.values()].filter(record =>
          canAccessDocument(record, context) && scope[record.visibility] &&
          (!scope.document_ids.length || scope.document_ids.includes(record.doc_id)) &&
          (!this.articles?.records.has(record.doc_id) || this.articles.records.get(record.doc_id)?.state === 'published'));
    const versions = rows.map(row => [row.doc_id, row.title, Number(row.document_version),
      row.active_index_version == null ? null : Number(row.active_index_version), row.visibility, row.team_id ?? null]);
    versions.sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
    return createHash('sha256').update(JSON.stringify(versions)).digest('hex');
  }

  /**
   * 分页读取已发布且公开可见的文章。
   *
   * @param page 当前页码或页面记录。
   * @param pageSize 每页返回的条目数。
   * @param filters 查询列表时使用的筛选条件。
   * @returns 当前页条目与符合条件的总数。
   */
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
    visible = visible.filter(r => !this.articles?.records.has(r.doc_id) || this.articles.records.get(r.doc_id)?.state === 'published');
    visible.sort((a, b) => (this.articles?.records.get(b.doc_id)?.published_at ?? b.created_at).getTime() - (this.articles?.records.get(a.doc_id)?.published_at ?? a.created_at).getTime());
    const total = visible.length;
    const offset = (page - 1) * pageSize;
    return { items: visible.slice(offset, offset + pageSize), total };
  }

  /**
   * 读取指定文章的公开发布内容。
   *
   * @param docId 知识文档标识。
   * @returns 知识文档记录。
   */
  async getPublicArticle(docId: string): Promise<DocumentRecord> {
    const article = await this.articles?.get(docId);
    if (article && article.state !== 'published') throw new NotFoundException('Public article not found.');
    const record = await this.require(docId);
    if (
      record.visibility !== 'public' ||
      !['public_article', 'article'].includes(record.source_type)
    ) {
      throw new NotFoundException('Public article not found.');
    }
    return record;
  }

  /**
   * 按标识读取知识文档。
   *
   * @param docId 知识文档标识。
   * @returns 知识文档记录；未找到或不可用时可能为空。
   */
  async get(docId: string): Promise<DocumentRecord | null> {
    if (!this.database.metadataEnabled) return this.records.get(docId) ?? null;
    return this.repository.findById(docId);
  }

  /**
   * 读取必需的知识文档，不存在时抛出错误。
   *
   * @param docId 知识文档标识。
   * @returns 知识文档记录。
   */
  async require(docId: string): Promise<DocumentRecord> {
    const record = await this.get(docId);
    if (!record || record.deleted_at) throw new NotFoundException('Document not found.');
    return record;
  }

  /**
   * 读取文档并检查当前用户是否具有访问权限。
   *
   * @param docId 知识文档标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 知识文档记录。
   */
  async getAccessible(docId: string, context: AccessContext): Promise<DocumentRecord> {
    const record = await this.require(docId);
    const article=await this.articles?.get(docId);
    if(article&&article.state!=='published'&&article.owner_id!==context.user_id) throw new ForbiddenException('Document access denied.');
    this.assertAccess(record, context);
    return record;
  }

  /**
   * 读取文档并检查当前用户是否具有修改权限。
   *
   * @param docId 知识文档标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 知识文档记录。
   */
  async getWritable(docId: string, context: AccessContext): Promise<DocumentRecord> {
    await this.assertUnmanaged(docId);
    const record = await this.require(docId);
    const allowed = record.space_id === context.space_id && (
      record.owner_id === context.user_id ||
      (record.visibility === 'team' && Boolean(record.team_id && context.team_ids.includes(record.team_id)))
    );
    if (!allowed) throw new ForbiddenException('Document write access denied.');
    return record;
  }

  /**
   * 根据请求更新知识文档。
   *
   * @param docId 知识文档标识。
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 知识文档记录。
   */
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
      category_id: nextVisibility==='private' && current.visibility==='private'?current.category_id ?? null:null,
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
    } else {
      const latest=this.records.get(docId);
      if(!latest || latest.deleted_at) throw new NotFoundException('Document not found.');
      if(latest.document_version!==current.document_version) throw new ConflictException('Document changed while saving.');
      next.category_id=next.visibility==='private'?latest.category_id ?? null:null;
      this.records.set(docId,next);
    }
    return next;
  }

  /**
   * 删除指定知识文档。
   *
   * @param docId 知识文档标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  async delete(docId: string, context: AccessContext): Promise<void> {
    await this.getWritable(docId, context);
    if (this.database.metadataEnabled) await this.database.transaction(async manager => {
      await manager.query('DELETE FROM knowledge_documents WHERE doc_id=?', [docId]);
      await this.interactions?.deleteForArticle(docId, manager);
    });
    else { this.records.delete(docId); await this.interactions?.deleteForArticle(docId); }
  }

  /**
   * 查询当前用户拥有的私有文档。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param manager 当前数据库事务执行器（可选）。
   * @returns 知识文档记录列表。
   */
  async ownedPrivate(context: AccessContext, manager?: import('typeorm').EntityManager): Promise<DocumentRecord[]> {
    if (this.database.metadataEnabled) {
      const sql = `SELECT * FROM knowledge_documents d WHERE d.visibility='private' AND d.space_id=? AND d.owner_id=?
        AND NOT EXISTS (SELECT 1 FROM article_drafts a WHERE a.article_id=d.doc_id)${manager ? ' FOR UPDATE' : ''}`;
      const rows = manager ? await manager.query(sql, [context.space_id, context.user_id])
        : await this.database.query(sql, [context.space_id, context.user_id]);
      return rows.map(mapDocumentRow);
    }
    return [...this.records.values()].filter(r => r.visibility === 'private' && r.owner_id === context.user_id &&
      r.space_id === context.space_id && !this.articles?.records.has(r.doc_id));
  }

  /**
   * 将分类或回收操作后的文档状态同步到当前存储视图。
   *
   * @param records 当前知识文档记录。
   * @param baseVersions 写入前各文档的版本映射。
   */
  applyWorkspaceRecords(records: DocumentRecord[],baseVersions:Map<string,number>): void {
    for (const record of records) {
      const current=this.records.get(record.doc_id);if(!current) continue;
      const delta=record.document_version-(baseVersions.get(record.doc_id) ?? record.document_version);
      this.records.set(record.doc_id,{...current,category_id:record.category_id,deleted_at:record.deleted_at,delete_batch_id:record.delete_batch_id,
        document_version:current.document_version+delta,
        ...(delta?{active_index_version:record.active_index_version,index_status:record.index_status}:{}),});
    }
  }
  /**
   * 彻底移除已进入回收站的文档记录。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  async purgeDeleted(id: string,context: AccessContext) {
    const d=(await this.ownedPrivate(context)).find(d => d.doc_id===id && d.deleted_at);
    if (!d) throw new NotFoundException('回收文档不存在');
    if (this.database.metadataEnabled) await this.database.query('DELETE FROM knowledge_documents WHERE doc_id=? AND owner_id=? AND deleted_at IS NOT NULL',[id,context.user_id]);
    else this.records.delete(id);
  }

  /**
   * 校验当前版本后切换生效的发布或索引状态。
   *
   * @param docId 知识文档标识。
   * @param version 本次操作对应的内容版本。
   * @param activate 当前数据库事务执行器。
   * @returns 条件是否满足的判断结果。
   */
  async activateCurrent(docId: string, version: number, activate: (manager?: import('typeorm').EntityManager) => Promise<void>): Promise<boolean> {
    if (this.database.metadataEnabled) return this.database.transaction(async manager => {
      const rows = await manager.query('SELECT document_version,deleted_at FROM knowledge_documents WHERE doc_id=? FOR UPDATE', [docId]);
      if (!rows[0] || rows[0].deleted_at || Number(rows[0].document_version) !== version) return false;
      await activate(manager);
      return true;
    });
    const work = (this.lifecycleWrites.get(docId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const row = this.records.get(docId);
      if (!row || row.deleted_at || row.document_version !== version) return false;
      await activate();
      return true;
    });
    this.lifecycleWrites.set(docId, work);
    try { return await work; } finally { if (this.lifecycleWrites.get(docId) === work) this.lifecycleWrites.delete(docId); }
  }

  /**
   * 阻止普通文档接口修改由文章或 Wiki 流程管理的文档。
   *
   * @param docId 知识文档标识。
   */
  async assertUnmanaged(docId: string): Promise<void> {
    if (await this.articles?.get(docId)) throw new ForbiddenException('Use the article publishing API to change this document.');
  }

  // Article publication is the sole writer of its public projection.
  /**
   * 写入文章发布流程管理的公开文档投影。
   *
   * @param record 当前知识文档记录。
   */
  setArticleSnapshot(record: DocumentRecord): void { this.records.set(record.doc_id, record); }
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

  /**
   * 将指定文档版本标记为正在建立索引。
   *
   * @param docId 知识文档标识。
   * @param version 本次操作对应的内容版本（可选）。
   */
  async markIndexing(docId: string, version?: number): Promise<void> {
    await this.patchState(docId, { index_status: 'indexing', index_error: null, updated_at: new Date() }, version);
  }

  /**
   * 记录索引已完成，并更新当前生效版本。
   *
   * @param docId 知识文档标识。
   * @param chunkCount 本次索引生成的分块数量。
   * @param version 本次操作对应的内容版本。
   * @param manager 当前数据库事务执行器（可选）。
   */
  async markReady(docId: string, chunkCount: number, version: number, manager?: import('typeorm').EntityManager): Promise<void> {
    if(manager) {
      await manager.query("UPDATE knowledge_documents SET index_status='ready',active_index_version=?,chunk_count=?,indexed_at=NOW(6),index_error=NULL WHERE doc_id=? AND document_version=? AND deleted_at IS NULL",[version,chunkCount,docId,version]);
      return;
    }
    await this.patchState(docId, {
      index_status: 'ready',
      active_index_version: version,
      chunk_count: chunkCount,
      indexed_at: new Date(),
      index_error: null,
      updated_at: new Date(),
    }, version);
  }

  /**
   * 保存后台处理失败状态及错误原因。
   *
   * @param docId 知识文档标识。
   * @param error 本次操作捕获的异常。
   */
  async markFailed(docId: string, error: string): Promise<void> {
    await this.patchState(docId, { index_status: 'failed', index_error: error.slice(0, 2000), updated_at: new Date() });
  }

  /**
   * 按当前文档状态检查访问身份，失败时抛出权限错误。
   *
   * @param record 当前知识文档记录。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  assertAccess(record: DocumentRecord, context: AccessContext): void {
    if (!canAccessDocument(record, context)) throw new ForbiddenException('Document access denied.');
  }

  /**
   * 团队写入权限闸门 ：当文档可见性为 team 时，必须指定一个有效的 team_id ，且当前用户必须属于这个团队，否则拒绝创建/更新。
   *
   * @param visibility 文档的公开、私有或团队可见性。
   * @param teamId team 对应的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  assertTeamTarget(visibility: Visibility, teamId: string | null | undefined, context: AccessContext): void {
    if (visibility === 'team' && (!teamId || !context.team_ids.includes(teamId))) {
      throw new ForbiddenException('Cannot write document into another team.');
    }
  }

  /**
   * 更新文档状态字段，保持内存与数据库路径的一致入口。
   *
   * @param docId 知识文档标识。
   * @param patch 当前知识文档记录。
   * @param version 本次操作对应的内容版本（可选）。
   */
  private async patchState(docId: string, patch: Partial<DocumentRecord>, version?: number): Promise<void> {
    const current = await this.require(docId);
    if (version !== undefined && current.document_version !== version) return;
    const next = { ...current, ...patch };
    if (this.database.metadataEnabled) {
      await this.repository.updateIndexState(next, version);
    } else this.records.set(docId, next);
  }
}

/**
 * 从补丁对象中筛出实际提供的字段。
 *
 * @param value 待校验或转换的值。
 * @returns Partial<T> 类型的处理结果。
 */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
