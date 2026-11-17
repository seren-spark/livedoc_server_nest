/**
 * @file 文档导入流程。管理上传、解析草稿、租约、重试、确认建档和过期清理。
 */
import { ConversationConstraintsService } from '../ai/conversation-constraints.service.js';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { AccessContext, Visibility } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import { publicAsset } from '../documents/assets/asset.types.js';
import type { DocumentAssetRecord } from '../documents/assets/asset.types.js';
import { AssetsService } from '../documents/assets/assets.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { toIndexRequest, type DocumentRecord } from '../documents/document.types.js';
import { IndexJobsService } from '../indexing/index-jobs.service.js';
import type { IndexJobRecord } from '../indexing/index-job.types.js';
import { DocumentMemoryJobsService } from '../documents/document-memory/document-memory-jobs.service.js';
import { DocumentMemoryService } from '../documents/document-memory/document-memory.service.js';
import { PersistentJobStore } from '../jobs/persistent-job-store.js';
import { BLOB_STORAGE, type BlobStorage } from '../storage/blob-storage.js';
import type { DocumentImportDraftDto } from '../common/dto.js';
import type { DocumentImportRecord, ImportJobRecord } from './document-import.types.js';
import {
  DocumentImportsRepository,
  mapImportJobRow,
} from './document-imports.repository.js';
import { validateDocumentFile } from '../uploads/document-signature.js';

@Injectable()
export class DocumentImportsService {
  private readonly imports = new Map<string, DocumentImportRecord>();
  private readonly jobs = new Map<string, ImportJobRecord>();
  private readonly jobStore: PersistentJobStore<ImportJobRecord>;
  private readonly repository: DocumentImportsRepository;

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param database 共享数据库服务。
   * @param assets 当前文档关联的资源集合。
   * @param documents 需要筛选或处理的文档集合。
   * @param indexJobs IndexJobsService 依赖实例。
   * @param memoryJobs DocumentMemoryJobsService 依赖实例。
   * @param documentMemory DocumentMemoryService 依赖实例。
   * @param blobs 已读取或创建的文件 Blob 集合。
   * @param constraints ConversationConstraintsService 依赖实例（可选）。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly assets: AssetsService,
    private readonly documents: DocumentsService,
    private readonly indexJobs: IndexJobsService,
    private readonly memoryJobs: DocumentMemoryJobsService,
    private readonly documentMemory: DocumentMemoryService,
    @Inject(BLOB_STORAGE) private readonly blobs: BlobStorage,
    private readonly constraints?: ConversationConstraintsService,
  ) {
    this.repository = new DocumentImportsRepository(database);
    this.jobStore = new PersistentJobStore({
      database: this.database,
      enabled: () => this.database.importJobsEnabled,
      tableName: 'document_import_jobs',
      leaseSeconds: () => this.config.importJobLeaseSeconds,
      jobs: this.jobs,
      mapRow: mapImportJobRow,
    });
  }

  /**
   * 校验上传内容后建立导入草稿并提交解析任务。
   *
   * @param input 当前用户、空间与团队身份，用于权限校验。
   * @returns 文档导入记录。
   */
  async createUpload(input: {
    data: Readable; filename: string; mime_type: string; title: string; visibility: Visibility;
    team_id: string | null; tags: string[]; folder: string | null; context: AccessContext;
  }): Promise<DocumentImportRecord> {
    const importId = randomUUID().replaceAll('-', '');
    const storageKey = `spaces/${input.context.space_id}/imports/${importId}/source/${safeFilename(input.filename)}`;
    const stored = await this.blobs.putStream(
      storageKey,
      input.data,
      this.config.importMaxUploadMb * 1024 * 1024,
    );
    try {
      const extension = input.filename.toLowerCase().endsWith('.pdf') ? '.pdf' : '.docx';
      try {
        await this.blobs.materialize(storageKey, (path) =>
          validateDocumentFile(path, extension),
        );
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Uploaded document is invalid.',
        );
      }
      const source = await this.assets.create({
        space_id: input.context.space_id, owner_id: input.context.user_id, import_id: importId,
        doc_id: null, kind: 'source', filename: input.filename, mime_type: input.mime_type,
        byte_size: stored.byteSize, sha256: stored.sha256, storage_key: storageKey,
        page_number: null, ordinal: null, width: null, height: null, ocr_text: '', description: '',
        analysis_status: 'ready', analysis_error: null,
      });
      const now = new Date();
      const job = this.makeJob(importId, input.context, 1, now);
      const record: DocumentImportRecord = {
        import_id: importId, space_id: input.context.space_id, owner_id: input.context.user_id,
        visibility: input.visibility, team_id: input.team_id, tags: input.tags, folder: input.folder,
        title: input.title, filename: input.filename, mime_type: input.mime_type,
        file_size: stored.byteSize, sha256: source.sha256, source_asset_id: source.asset_id,
        status: 'queued', progress: 5, stage: '等待解析', parsed_content: '', editor_content: null,
        parser_version: null, error: null, document_id: null, latest_job_id: job.job_id,
        created_at: now, updated_at: now,
      };
      if (this.database.importJobsEnabled) {
        await this.repository.create(record, job);
      } else { this.imports.set(importId, record); this.jobs.set(job.job_id, job); }
      return this.withAssets(record);
    } catch (error) {
      await this.assets.removeWhere({ import_id: importId });
      await this.blobs.delete(storageKey);
      throw error;
    }
  }

  /**
   * 按标识读取文档导入记录。
   *
   * @param importId 文档导入记录标识。
   * @returns 文档导入记录；未找到或不可用时可能为空。
   */
  async get(importId: string): Promise<DocumentImportRecord | null> {
    let record: DocumentImportRecord | null;
    if (!this.database.importJobsEnabled) record = this.imports.get(importId) ?? null;
    else record = await this.repository.findById(importId);
    return record ? this.withAssets(record) : null;
  }

  /**
   * 读取必需的文档导入记录，不存在时抛出错误。
   *
   * @param importId 文档导入记录标识。
   * @returns 文档导入记录。
   */
  async require(importId: string): Promise<DocumentImportRecord> {
    const record = await this.get(importId);
    if (!record) throw new NotFoundException('Document import not found.');
    return record;
  }

  /**
   * 确认资源或导入记录属于当前用户与空间。
   *
   * @param record 当前导入草稿记录。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  assertOwner(record: DocumentImportRecord, context: AccessContext): void {
    if (record.space_id !== context.space_id || record.owner_id !== context.user_id) {
      throw new ForbiddenException('Document import access denied.');
    }
  }

  /**
   * 保存用户对导入解析结果所做的修改。
   *
   * @param importId 文档导入记录标识。
   * @param request 当前业务请求。
   * @returns 文档导入记录。
   */
  async saveDraft(importId: string, request: DocumentImportDraftDto): Promise<DocumentImportRecord> {
    const record = await this.require(importId);
    if (!['review_ready', 'failed'].includes(record.status)) throw new ConflictException('Import is not ready for editor updates.');
    return this.patch(importId, {
      title: request.title ?? record.title,
      parsed_content: request.content ?? record.parsed_content,
      editor_content: request.editor_content === undefined ? record.editor_content : request.editor_content,
    });
  }

  /**
   * 确认导入草稿，创建或关联正式文档并安排后续索引。
   *
   * @param importId 文档导入记录标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 知识文档记录列表。
   */
  async confirm(importId: string, context: AccessContext): Promise<{
    document: DocumentRecord;
    assets: DocumentAssetRecord[];
    job: IndexJobRecord;
  }> {
    if (this.database.metadataEnabled && this.database.indexJobsEnabled && this.database.importJobsEnabled) {
      const ids = await this.database.transaction(async (manager) => {
        const record = await this.repository.lockImport(manager, importId);
        if (!record) throw new NotFoundException('Document import not found.');
        this.assertOwner(record, context);
        if (record.status === 'confirmed' && record.document_id) {
          return {
            docId: record.document_id,
            jobId: await this.repository.latestDocumentJobId(manager, record.document_id),
          };
        }
        if (record.status !== 'review_ready') {
          throw new ConflictException('Import must be reviewed before confirmation.');
        }
        if (!record.parsed_content.trim()) {
          throw new BadRequestException('Parsed document content is empty.');
        }

        const docId = `import_${record.import_id}`;
        const assets = await this.repository.lockAssets(manager, importId);
        const existingDocument = await this.repository.lockDocument(manager, docId);
        let document: DocumentRecord;
        if (existingDocument) {
          document = existingDocument;
          if (document.source_import_id !== importId) {
            throw new ConflictException('Import document id is already owned by another source.');
          }
        } else {
          const now = new Date();
          document = {
            doc_id: docId,
            space_id: record.space_id,
            title: record.title,
            content: record.parsed_content,
            visibility: record.visibility,
            source_type: record.visibility === 'team'
              ? 'team_doc'
              : record.visibility === 'public' ? 'public_article' : 'note',
            tags: [...record.tags],
            team_id: record.team_id,
            owner_id: record.owner_id,
            url: null,
            editor_content: record.editor_content,
            source_import_id: record.import_id,
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
          await this.repository.insertDocument(manager, document);
        }

        const dedupeKey = `${docId}:${document.document_version}`;
        let jobId = await this.repository.findIndexJobId(
          manager,
          document.latest_index_job_id,
          dedupeKey,
        );
        if (!jobId) {
          const now = new Date();
          jobId = randomUUID().replaceAll('-', '');
          const job: IndexJobRecord = {
            job_id: jobId,
            doc_id: docId,
            document_version: document.document_version,
            generation: await this.repository.nextIndexGeneration(
              manager,
              docId,
              document.document_version,
            ),
            status: 'queued',
            attempts: 0,
            max_attempts: this.config.indexJobMaxAttempts,
            requested_by: context.user_id,
            space_id: context.space_id,
            request_payload: {
              ...toIndexRequest(document),
              content: buildIndexContent(document.content, assets),
            },
            config_fingerprint: this.config.configFingerprint,
            dedupe_key: dedupeKey,
            worker_id: null,
            lease_expires_at: null,
            next_run_at: now,
            error: null,
            created_at: now,
            started_at: null,
            finished_at: null,
            updated_at: now,
          };
          await this.repository.insertIndexJob(manager, job);
        }

        const now = new Date();
        await this.repository.confirm(manager, importId, docId, jobId, assets, now);
        return { docId, jobId };
      });
      if (!ids.jobId) throw new ConflictException('Confirmed import has no index job.');
      await this.queueDocumentMemory(await this.documents.require(ids.docId), context);
      return this.confirmationResponse(ids.docId, ids.jobId);
    }

    const record = await this.require(importId);
    this.assertOwner(record, context);
    if (record.status === 'confirmed' && record.document_id) {
      const confirmedDocument = await this.documents.require(record.document_id);
      if (!confirmedDocument.latest_index_job_id) throw new ConflictException('Confirmed import has no index job.');
      return this.confirmationResponse(record.document_id, confirmedDocument.latest_index_job_id);
    }
    if (record.status !== 'review_ready') throw new ConflictException('Import must be reviewed before confirmation.');
    if (!record.parsed_content.trim()) throw new BadRequestException('Parsed document content is empty.');
    const docId = `import_${record.import_id}`;
    const assets = await this.assets.list({ import_id: importId });
    let document = await this.documents.get(docId);
    if (!document) {
      document = await this.documents.create({
        doc_id: docId,
        title: record.title,
        content: record.parsed_content,
        editor_content: record.editor_content,
        source_import_id: record.import_id,
        visibility: record.visibility,
        source_type: record.visibility === 'team' ? 'team_doc' : record.visibility === 'public' ? 'public_article' : 'note',
        tags: record.tags,
        team_id: record.team_id,
        index_now: true,
        asset_ids: assets.map((asset) => asset.asset_id),
      }, context);
    }
    let job = document.latest_index_job_id ? await this.indexJobs.get(document.latest_index_job_id) : null;
    if (!job) {
      job = await this.indexJobs.enqueue({
        ...toIndexRequest(document),
        content: buildIndexContent(document.content, assets),
      }, context);
      await this.documents.markQueued(document.doc_id, job.job_id);
    }
    await this.assets.link(assets.map((asset) => asset.asset_id), document.doc_id, context);
    await this.queueDocumentMemory(document, context);
    await this.patch(importId, {
      status: 'confirmed', stage: '已保存到知识库', document_id: document.doc_id,
      progress: 100, error: null,
    });
    return this.confirmationResponse(document.doc_id, job.job_id);
  }

  /**
   * 整理导入确认后的文档与任务响应信息。
   *
   * @param docId 知识文档标识。
   * @param jobId 后台任务标识。
   * @returns 知识文档记录列表。
   */
  private async confirmationResponse(docId: string, jobId: string): Promise<{
    document: DocumentRecord;
    assets: DocumentAssetRecord[];
    job: IndexJobRecord;
  }> {
    const document = await this.documents.require(docId);
    const job = await this.indexJobs.get(jobId);
    if (!job) throw new ConflictException('Confirmed import index job is missing.');
    return { document, assets: await this.assets.list({ doc_id: docId }), job };
  }

  /**
   * 仅更新本次请求提供的文档导入记录字段。
   *
   * @param importId 文档导入记录标识。
   * @param values 当前导入草稿记录。
   * @returns 文档导入记录。
   */
  async patch(importId: string, values: Partial<DocumentImportRecord>): Promise<DocumentImportRecord> {
    const current = await this.require(importId);
    const next = { ...current, ...values, assets: undefined, updated_at: new Date() };
    if (this.database.importJobsEnabled) {
      await this.repository.patch(importId, values, next.updated_at);
    } else this.imports.set(importId, next);
    return this.withAssets(next);
  }

  /**
   * 检查当前状态后重新提交失败的任务。
   *
   * @param importId 文档导入记录标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 文档导入记录。
   */
  async retry(importId: string, context: AccessContext): Promise<DocumentImportRecord> {
    const current = await this.require(importId);
    if (!['failed', 'retry_wait', 'review_ready'].includes(current.status)) throw new ConflictException('Import cannot be retried.');
    const generation = await this.nextGeneration(importId);
    const job = this.makeJob(importId, context, generation, new Date());
    if (this.database.importJobsEnabled) {
      await this.repository.insertJob(job);
    } else this.jobs.set(job.job_id, job);
    return this.patch(importId, { status: 'queued', stage: '等待解析', progress: 5, error: null, latest_job_id: job.job_id });
  }

  /**
   * 领取下一条可执行任务，并取得对应执行代次与租约。
   *
   * @param workerId 当前执行 Worker 的标识。
   * @returns ImportJobRecord 类型的处理结果；未找到或不可用时可能为空。
   */
  async claimNext(workerId: string): Promise<ImportJobRecord | null> {
    const claimed = await this.jobStore.claimNext(workerId);
    if (claimed) await this.patch(claimed.import_id, { status: 'parsing', progress: 15, stage: '解析文档结构', error: null });
    return claimed;
  }

  /**
   * 续期当前 Worker 的任务租约。
   *
   * @param job 当前导入解析任务。
   * @returns 条件是否满足的判断结果。
   */
  async heartbeat(job: ImportJobRecord): Promise<boolean> {
    return this.jobStore.heartbeat(job.job_id, job.worker_id ?? '', job.generation);
  }

  /**
   * 检查当前 Worker 与执行代次是否仍持有任务租约。
   *
   * @param job 当前导入解析任务。
   * @returns 条件是否满足的判断结果。
   */
  async ownsLease(job: ImportJobRecord): Promise<boolean> {
    return this.jobStore.ownsLease(job.job_id, job.worker_id, job.generation);
  }

  /**
   * 将当前执行任务标记为成功，并保存结果状态。
   *
   * @param job 当前导入解析任务。
   */
  async succeed(job: ImportJobRecord): Promise<void> { await this.finishJob(job, 'succeeded', null); }

  /**
   * 记录任务失败原因，并根据剩余次数安排重试或结束。
   *
   * @param job 当前导入解析任务。
   * @param error 本次操作捕获的异常。
   */
  async fail(job: ImportJobRecord, error: string): Promise<void> {
    const terminal = job.attempts >= job.max_attempts;
    const status = terminal ? 'failed' : 'retry_wait';
    const delays = [30, 120, 600];
    const delay = delays[Math.min(Math.max(job.attempts - 1, 0), delays.length - 1)]!;
    await this.finishJob(job, status, error, new Date(Date.now() + delay * 1000));
    await this.patch(job.import_id, { status, stage: terminal ? '解析失败' : '等待重试', error: error.slice(0, 2000) });
  }

  /**
   * 检查当前状态后移除指定文档导入记录。
   *
   * @param importId 文档导入记录标识。
   */
  async remove(importId: string): Promise<void> {
    const current = await this.require(importId);
    if (['uploaded', 'queued', 'parsing', 'retry_wait'].includes(current.status)) {
      await this.jobStore.cancelWhere({
        whereSql: 'import_id=?',
        params: [importId],
        predicate: (job) => job.import_id === importId,
        error: 'Canceled by user',
      });
      await this.patch(importId, { status: 'canceled', stage: '已取消', error: null });
      return;
    }
    await this.constraints?.deleteDocument(importId, 'import');
    await this.assets.removeWhere({ import_id: importId });
    if (this.database.importJobsEnabled) {
      await this.repository.delete(importId);
    } else {
      this.imports.delete(importId);
    }
    await this.jobStore.deleteWhere({
      whereSql: 'import_id=?',
      params: [importId],
      predicate: (job) => job.import_id === importId,
    });
  }

  /**
   * 删除超过保留期限的导入记录及相关资源。
   *
   * @returns 计算得到的数值。
   */
  async cleanupExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.importRetentionDays * 86400_000);
    const ids = !this.database.importJobsEnabled
      ? [...this.imports.values()].filter((item) => item.status !== 'confirmed' && item.updated_at < cutoff).map((item) => item.import_id)
      : await this.repository.listExpiredIds(cutoff);
    for (const id of ids) await this.remove(id);
    return ids.length;
  }

  /**
   * 为已确认或更新的文档安排长期记忆提取任务。
   *
   * @param document 当前知识文档记录。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  private async queueDocumentMemory(document: DocumentRecord, context: AccessContext): Promise<void> {
    if (!this.config.documentMemoryEnabled || !document.content.trim()) return;
    try {
      await this.memoryJobs.enqueue(document, context);
    } catch (error) {
      await this.documentMemory.markPending(document);
      await this.documentMemory.markFailed(
        document.doc_id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * 为业务记录补充已关联的图片资源信息。
   *
   * @param record 当前导入草稿记录。
   * @returns 文档导入记录。
   */
  private async withAssets(record: DocumentImportRecord): Promise<DocumentImportRecord> {
    return { ...record, assets: (await this.assets.list({ import_id: record.import_id })).map(publicAsset) };
  }

  /**
   * 根据当前导入版本构造一条新的解析任务。
   *
   * @param importId 文档导入记录标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param now 本次操作采用的时间基准。
   * @returns ImportJobRecord 类型的处理结果。
   */
  private makeJob(importId: string, context: AccessContext, generation: number, now: Date): ImportJobRecord {
    return { job_id: randomUUID().replaceAll('-',''), import_id: importId, status: 'queued', attempts: 0,
      max_attempts: this.config.importJobMaxAttempts, generation, requested_by: context.user_id,
      space_id: context.space_id, config_fingerprint: this.config.configFingerprint,
      worker_id: null, lease_expires_at: null, next_run_at: now,
      error: null, created_at: now, started_at: null, finished_at: null, updated_at: now };
  }

  /**
   * 根据已有任务记录计算下一次执行代次。
   *
   * @param importId 文档导入记录标识。
   * @returns 计算得到的数值。
   */
  private async nextGeneration(importId: string): Promise<number> {
    if (!this.database.importJobsEnabled) return Math.max(0, ...[...this.jobs.values()].filter((job)=>job.import_id===importId).map((job)=>job.generation)) + 1;
    return this.repository.nextGeneration(importId);
  }

  /**
   * 校验执行代次后完成任务状态写回。
   *
   * @param job 当前导入解析任务。
   * @param status 当前导入解析任务。
   * @param error 本次操作捕获的异常。
   * @param nextRunAt nextRunAt 参数。
   */
  private async finishJob(job: ImportJobRecord, status: ImportJobRecord['status'], error: string | null, nextRunAt = job.next_run_at): Promise<void> {
    await this.jobStore.finish(job.job_id, status, {
      error,
      nextRunAt,
      workerId: job.worker_id,
      generation: job.generation,
    });
  }
}

/**
 * 合并正文与图片说明，构造实际用于知识检索的索引文本。
 *
 * @param content 待处理的正文内容。
 * @param assets 当前文档关联的资源集合。
 * @returns 整理后的文本或标识。
 */
export function buildIndexContent(content: string, assets: DocumentAssetRecord[]): string {
  const sections = assets
    .filter((asset) => asset.kind !== 'source' && (asset.ocr_text || asset.description))
    .map((asset) => {
      const location = [
        asset.ordinal == null ? '' : `图片 ${asset.ordinal}`,
        asset.page_number == null ? '' : `第 ${asset.page_number} 页`,
      ].filter(Boolean).join('，');
      const text = [asset.ocr_text, asset.description].filter(Boolean).join('\n\n');
      return `### ${location || '图片内容'}\n\n${text}`;
    });
  return sections.length
    ? `${content.trim()}\n\n## 图片可检索内容\n\n${sections.join('\n\n')}`
    : content;
}

/**
 * 清理上传文件名中的路径与非法字符。
 *
 * @param filename 上传文件的原始名称。
 * @returns 整理后的文本或标识。
 */
export function safeFilename(filename: string): string {
  const safe = filename.split(/[\\/]/u).at(-1)?.trim().replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0,512);
  if (!safe || safe === '.' || safe === '..') throw new BadRequestException('Invalid filename.');
  return safe;
}
