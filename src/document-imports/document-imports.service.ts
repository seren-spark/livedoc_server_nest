import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { AccessContext, Visibility } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import { publicAsset } from '../documents/asset.types.js';
import type { DocumentAssetRecord } from '../documents/asset.types.js';
import { AssetsService, mapAssetRow } from '../documents/assets.service.js';
import { DocumentsService, mapDocumentRow } from '../documents/documents.service.js';
import { toIndexRequest, type DocumentRecord } from '../documents/document.types.js';
import { IndexJobsService } from '../indexing/index-jobs.service.js';
import type { IndexJobRecord } from '../indexing/index-job.types.js';
import { BLOB_STORAGE, type BlobStorage } from '../storage/blob-storage.js';
import type { DocumentImportDraftDto } from '../common/dto.js';
import type { DocumentImportRecord, ImportJobRecord } from './document-import.types.js';
import { validateDocumentFile } from '../uploads/document-signature.js';

@Injectable()
export class DocumentImportsService {
  private readonly imports = new Map<string, DocumentImportRecord>();
  private readonly jobs = new Map<string, ImportJobRecord>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly assets: AssetsService,
    private readonly documents: DocumentsService,
    private readonly indexJobs: IndexJobsService,
    @Inject(BLOB_STORAGE) private readonly blobs: BlobStorage,
  ) {}

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
        await this.database.source.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO document_imports
             (import_id,space_id,owner_id,visibility,team_id,tags,folder,title,filename,mime_type,
              file_size,sha256,source_asset_id,status,progress,stage,parsed_content,editor_content,
              parser_version,error,document_id,latest_job_id,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, importValues(record));
          await manager.query(
            `INSERT INTO document_import_jobs
             (job_id,import_id,status,attempts,max_attempts,generation,requested_by,space_id,config_fingerprint,worker_id,
              lease_expires_at,next_run_at,error,created_at,started_at,finished_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, jobValues(job));
        });
      } else { this.imports.set(importId, record); this.jobs.set(job.job_id, job); }
      return this.withAssets(record);
    } catch (error) {
      await this.assets.removeWhere({ import_id: importId });
      await this.blobs.delete(storageKey);
      throw error;
    }
  }

  async get(importId: string): Promise<DocumentImportRecord | null> {
    let record: DocumentImportRecord | null;
    if (!this.database.importJobsEnabled) record = this.imports.get(importId) ?? null;
    else {
      const rows = await this.database.query<Record<string, unknown>>('SELECT * FROM document_imports WHERE import_id=?', [importId]);
      record = rows[0] ? mapImport(rows[0]) : null;
    }
    return record ? this.withAssets(record) : null;
  }

  async require(importId: string): Promise<DocumentImportRecord> {
    const record = await this.get(importId);
    if (!record) throw new NotFoundException('Document import not found.');
    return record;
  }

  assertOwner(record: DocumentImportRecord, context: AccessContext): void {
    if (record.space_id !== context.space_id || record.owner_id !== context.user_id) {
      throw new ForbiddenException('Document import access denied.');
    }
  }

  async saveDraft(importId: string, request: DocumentImportDraftDto): Promise<DocumentImportRecord> {
    const record = await this.require(importId);
    if (!['review_ready', 'failed'].includes(record.status)) throw new ConflictException('Import is not ready for editor updates.');
    return this.patch(importId, {
      title: request.title ?? record.title,
      parsed_content: request.content ?? record.parsed_content,
      editor_content: request.editor_content === undefined ? record.editor_content : request.editor_content,
    });
  }

  async confirm(importId: string, context: AccessContext): Promise<{
    document: DocumentRecord;
    assets: DocumentAssetRecord[];
    job: IndexJobRecord;
  }> {
    if (this.database.metadataEnabled && this.database.indexJobsEnabled && this.database.importJobsEnabled) {
      const ids = await this.database.source.transaction(async (manager) => {
        const importRows = await manager.query(
          'SELECT * FROM document_imports WHERE import_id=? FOR UPDATE',
          [importId],
        ) as Record<string, unknown>[];
        if (!importRows[0]) throw new NotFoundException('Document import not found.');
        const record = mapImport(importRows[0]);
        this.assertOwner(record, context);
        if (record.status === 'confirmed' && record.document_id) {
          const confirmedDocuments = await manager.query(
            'SELECT latest_index_job_id FROM knowledge_documents WHERE doc_id=?',
            [record.document_id],
          ) as Array<{ latest_index_job_id: string | null }>;
          return {
            docId: record.document_id,
            jobId: confirmedDocuments[0]?.latest_index_job_id ?? null,
          };
        }
        if (record.status !== 'review_ready') {
          throw new ConflictException('Import must be reviewed before confirmation.');
        }
        if (!record.parsed_content.trim()) {
          throw new BadRequestException('Parsed document content is empty.');
        }

        const docId = `import_${record.import_id}`;
        const assetRows = await manager.query(
          'SELECT * FROM document_assets WHERE import_id=? ORDER BY COALESCE(ordinal, 0), created_at FOR UPDATE',
          [importId],
        ) as Record<string, unknown>[];
        const assets = assetRows.map(mapAssetRow);
        const documentRows = await manager.query(
          'SELECT * FROM knowledge_documents WHERE doc_id=? FOR UPDATE',
          [docId],
        ) as Record<string, unknown>[];
        let document: DocumentRecord;
        if (documentRows[0]) {
          document = mapDocumentRow(documentRows[0]);
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
          await manager.query(
            `INSERT INTO knowledge_documents
              (doc_id,space_id,title,content,visibility,source_type,tags,team_id,owner_id,url,
               editor_content,source_import_id,document_version,index_status,chunk_count,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,1,'pending',0,?,?)`,
            [
              document.doc_id, document.space_id, document.title, document.content,
              document.visibility, document.source_type, JSON.stringify(document.tags),
              document.team_id, document.owner_id, document.url,
              document.editor_content == null ? null : JSON.stringify(document.editor_content),
              document.source_import_id, now, now,
            ],
          );
        }

        let jobRows: Record<string, unknown>[] = [];
        if (document.latest_index_job_id) {
          jobRows = await manager.query('SELECT * FROM index_jobs WHERE job_id=?', [document.latest_index_job_id]);
        }
        if (!jobRows[0]) {
          jobRows = await manager.query(
            'SELECT * FROM index_jobs WHERE dedupe_key=? LIMIT 1 FOR UPDATE',
            [`${docId}:${document.document_version}`],
          );
        }
        let jobId = jobRows[0] ? String(jobRows[0].job_id) : '';
        if (!jobId) {
          const generationRows = await manager.query(
            `SELECT COALESCE(MAX(generation),0) AS generation FROM index_jobs
             WHERE doc_id=? AND document_version=?`,
            [docId, document.document_version],
          ) as Array<{ generation: number | string }>;
          const now = new Date();
          jobId = randomUUID().replaceAll('-', '');
          const request = {
            ...toIndexRequest(document),
            content: buildIndexContent(document.content, assets),
          };
          await manager.query(
            `INSERT INTO index_jobs
              (job_id,doc_id,document_version,generation,status,attempts,max_attempts,
               requested_by,space_id,request_payload,config_fingerprint,dedupe_key,
               next_run_at,created_at,updated_at)
             VALUES (?,?,?,?, 'queued',0,?,?,?,?,?,?, ?,?,?)`,
            [
              jobId, docId, document.document_version,
              Number(generationRows[0]?.generation ?? 0) + 1,
              this.config.indexJobMaxAttempts, context.user_id, context.space_id,
              JSON.stringify(request), this.config.configFingerprint,
              `${docId}:${document.document_version}`, now, now, now,
            ],
          );
        }

        const now = new Date();
        await manager.query(
          `UPDATE knowledge_documents SET index_status='queued',latest_index_job_id=?,
           index_error=NULL,updated_at=? WHERE doc_id=?`,
          [jobId, now, docId],
        );
        if (assets.length) {
          await manager.query(
            `UPDATE document_assets SET doc_id=? WHERE asset_id IN (${assets.map(() => '?').join(',')})`,
            [docId, ...assets.map((asset) => asset.asset_id)],
          );
        }
        await manager.query(
          `UPDATE document_imports SET status='confirmed',stage=?,document_id=?,progress=100,
           error=NULL,updated_at=? WHERE import_id=?`,
          ['已保存到知识库', docId, now, importId],
        );
        return { docId, jobId };
      });
      if (!ids.jobId) throw new ConflictException('Confirmed import has no index job.');
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
    await this.patch(importId, {
      status: 'confirmed', stage: '已保存到知识库', document_id: document.doc_id,
      progress: 100, error: null,
    });
    return this.confirmationResponse(document.doc_id, job.job_id);
  }

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

  async patch(importId: string, values: Partial<DocumentImportRecord>): Promise<DocumentImportRecord> {
    const current = await this.require(importId);
    const next = { ...current, ...values, assets: undefined, updated_at: new Date() };
    if (this.database.importJobsEnabled) {
      const entries = Object.entries(values).filter(([key]) => key !== 'assets');
      if (entries.length) {
        await this.database.query(
          `UPDATE document_imports SET ${entries.map(([key]) => `${key}=?`).join(',')}, updated_at=? WHERE import_id=?`,
          [...entries.map(([key, value]) => key === 'editor_content' && value != null ? JSON.stringify(value) : value), next.updated_at, importId],
        );
      }
    } else this.imports.set(importId, next);
    return this.withAssets(next);
  }

  async retry(importId: string, context: AccessContext): Promise<DocumentImportRecord> {
    const current = await this.require(importId);
    if (!['failed', 'retry_wait', 'review_ready'].includes(current.status)) throw new ConflictException('Import cannot be retried.');
    const generation = await this.nextGeneration(importId);
    const job = this.makeJob(importId, context, generation, new Date());
    if (this.database.importJobsEnabled) {
      await this.database.query(
        `INSERT INTO document_import_jobs
         (job_id,import_id,status,attempts,max_attempts,generation,requested_by,space_id,config_fingerprint,worker_id,
          lease_expires_at,next_run_at,error,created_at,started_at,finished_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, jobValues(job));
    } else this.jobs.set(job.job_id, job);
    return this.patch(importId, { status: 'queued', stage: '等待解析', progress: 5, error: null, latest_job_id: job.job_id });
  }

  async claimNext(workerId: string): Promise<ImportJobRecord | null> {
    const now = new Date();
    let claimed: ImportJobRecord | null = null;
    if (!this.database.importJobsEnabled) {
      const candidate = [...this.jobs.values()].sort((a,b) => a.created_at.getTime()-b.created_at.getTime()).find((job) =>
        (['queued','retry_wait'].includes(job.status) && job.next_run_at <= now) ||
        (job.status === 'running' && Boolean(job.lease_expires_at && job.lease_expires_at <= now)));
      if (!candidate) return null;
      claimed = { ...candidate, status: 'running', attempts: candidate.attempts + 1, worker_id: workerId,
        lease_expires_at: new Date(now.getTime() + this.config.importJobLeaseSeconds * 1000),
        started_at: candidate.started_at ?? now, updated_at: now };
      this.jobs.set(claimed.job_id, claimed);
    } else {
      const runner = this.database.source.createQueryRunner();
      await runner.connect(); await runner.startTransaction();
      try {
        const rows = await runner.query(
          `SELECT * FROM document_import_jobs WHERE
           ((status IN ('queued','retry_wait') AND next_run_at<=?) OR
            (status='running' AND lease_expires_at<=?))
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [now, now]) as Record<string, unknown>[];
        if (rows[0]) {
          claimed = { ...mapJob(rows[0]), status: 'running', attempts: Number(rows[0].attempts)+1,
            worker_id: workerId, lease_expires_at: new Date(now.getTime()+this.config.importJobLeaseSeconds*1000),
            started_at: rows[0].started_at ? new Date(rows[0].started_at as string) : now, updated_at: now };
          await runner.query(`UPDATE document_import_jobs SET status='running',attempts=?,worker_id=?,lease_expires_at=?,started_at=?,updated_at=? WHERE job_id=?`,
            [claimed.attempts,workerId,claimed.lease_expires_at,claimed.started_at,now,claimed.job_id]);
        }
        await runner.commitTransaction();
      } catch (error) { await runner.rollbackTransaction(); throw error; }
      finally { await runner.release(); }
    }
    if (claimed) await this.patch(claimed.import_id, { status: 'parsing', progress: 15, stage: '解析文档结构', error: null });
    return claimed;
  }

  async heartbeat(job: ImportJobRecord): Promise<boolean> {
    const lease = new Date(Date.now() + this.config.importJobLeaseSeconds * 1000);
    if (this.database.importJobsEnabled) {
      const result = await this.database.source.query(
        `UPDATE document_import_jobs SET lease_expires_at=?,updated_at=UTC_TIMESTAMP(6)
         WHERE job_id=? AND worker_id=? AND generation=? AND status='running'`,
        [lease, job.job_id, job.worker_id, job.generation],
      );
      return Number(result?.affectedRows ?? 0) === 1;
    }
    const current = this.jobs.get(job.job_id);
    if (!current || current.worker_id !== job.worker_id || current.generation !== job.generation || current.status !== 'running') return false;
    this.jobs.set(job.job_id, { ...current, lease_expires_at: lease, updated_at: new Date() });
    return true;
  }

  async ownsLease(job: ImportJobRecord): Promise<boolean> {
    const current = this.database.importJobsEnabled
      ? (await this.database.query<Record<string, unknown>>('SELECT * FROM document_import_jobs WHERE job_id=?', [job.job_id]))[0]
      : this.jobs.get(job.job_id);
    if (!current) return false;
    const mapped = current instanceof Object && 'job_id' in current && current.created_at instanceof Date
      ? current as ImportJobRecord
      : mapJob(current as Record<string, unknown>);
    return mapped.status === 'running' && mapped.worker_id === job.worker_id && mapped.generation === job.generation && Boolean(mapped.lease_expires_at && mapped.lease_expires_at > new Date());
  }

  async succeed(job: ImportJobRecord): Promise<void> { await this.finishJob(job, 'succeeded', null); }

  async fail(job: ImportJobRecord, error: string): Promise<void> {
    const terminal = job.attempts >= job.max_attempts;
    const status = terminal ? 'failed' : 'retry_wait';
    const delays = [30, 120, 600];
    const delay = delays[Math.min(Math.max(job.attempts - 1, 0), delays.length - 1)]!;
    await this.finishJob(job, status, error, new Date(Date.now() + delay * 1000));
    await this.patch(job.import_id, { status, stage: terminal ? '解析失败' : '等待重试', error: error.slice(0, 2000) });
  }

  async remove(importId: string): Promise<void> {
    const current = await this.require(importId);
    if (['uploaded', 'queued', 'parsing', 'retry_wait'].includes(current.status)) {
      if (this.database.importJobsEnabled) {
        await this.database.query(
          `UPDATE document_import_jobs SET status='canceled',worker_id=NULL,lease_expires_at=NULL,
           error='Canceled by user',finished_at=UTC_TIMESTAMP(6),updated_at=UTC_TIMESTAMP(6)
           WHERE import_id=? AND status IN ('queued','running','retry_wait')`,
          [importId],
        );
      } else {
        for (const [id, job] of this.jobs) {
          if (job.import_id === importId && ['queued', 'running', 'retry_wait'].includes(job.status)) {
            this.jobs.set(id, { ...job, status: 'canceled', worker_id: null, lease_expires_at: null, error: 'Canceled by user', finished_at: new Date(), updated_at: new Date() });
          }
        }
      }
      await this.patch(importId, { status: 'canceled', stage: '已取消', error: null });
      return;
    }
    await this.assets.removeWhere({ import_id: importId });
    if (this.database.importJobsEnabled) {
      await this.database.query('DELETE FROM document_import_jobs WHERE import_id=?', [importId]);
      await this.database.query('DELETE FROM document_imports WHERE import_id=?', [importId]);
    } else {
      for (const [id, job] of this.jobs) if (job.import_id === importId) this.jobs.delete(id);
      this.imports.delete(importId);
    }
  }

  async cleanupExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.importRetentionDays * 86400_000);
    const ids = !this.database.importJobsEnabled
      ? [...this.imports.values()].filter((item) => item.status !== 'confirmed' && item.updated_at < cutoff).map((item) => item.import_id)
      : (await this.database.query<{ import_id: string }>("SELECT import_id FROM document_imports WHERE status<>'confirmed' AND updated_at<?", [cutoff])).map((row) => row.import_id);
    for (const id of ids) await this.remove(id);
    return ids.length;
  }

  private async withAssets(record: DocumentImportRecord): Promise<DocumentImportRecord> {
    return { ...record, assets: (await this.assets.list({ import_id: record.import_id })).map(publicAsset) };
  }

  private makeJob(importId: string, context: AccessContext, generation: number, now: Date): ImportJobRecord {
    return { job_id: randomUUID().replaceAll('-',''), import_id: importId, status: 'queued', attempts: 0,
      max_attempts: this.config.importJobMaxAttempts, generation, requested_by: context.user_id,
      space_id: context.space_id, config_fingerprint: this.config.configFingerprint,
      worker_id: null, lease_expires_at: null, next_run_at: now,
      error: null, created_at: now, started_at: null, finished_at: null, updated_at: now };
  }

  private async nextGeneration(importId: string): Promise<number> {
    if (!this.database.importJobsEnabled) return Math.max(0, ...[...this.jobs.values()].filter((job)=>job.import_id===importId).map((job)=>job.generation)) + 1;
    const rows = await this.database.query<{ generation: number }>('SELECT COALESCE(MAX(generation),0) AS generation FROM document_import_jobs WHERE import_id=?', [importId]);
    return Number(rows[0]?.generation ?? 0) + 1;
  }

  private async finishJob(job: ImportJobRecord, status: ImportJobRecord['status'], error: string | null, nextRunAt = job.next_run_at): Promise<void> {
    const next = { ...job, status, error, next_run_at: nextRunAt, worker_id: null, lease_expires_at: null,
      finished_at: status === 'failed' || status === 'succeeded' ? new Date() : null, updated_at: new Date() };
    if (this.database.importJobsEnabled) await this.database.query(
      `UPDATE document_import_jobs SET status=?,error=?,next_run_at=?,worker_id=NULL,lease_expires_at=NULL,finished_at=?,updated_at=?
       WHERE job_id=? AND worker_id=? AND generation=? AND status='running'`,
      [next.status,next.error,next.next_run_at,next.finished_at,next.updated_at,next.job_id,job.worker_id,job.generation]);
    else this.jobs.set(next.job_id, next);
  }
}

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

export function safeFilename(filename: string): string {
  const safe = filename.split(/[\\/]/u).at(-1)?.trim().replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0,512);
  if (!safe || safe === '.' || safe === '..') throw new BadRequestException('Invalid filename.');
  return safe;
}

function importValues(r: DocumentImportRecord): unknown[] { return [r.import_id,r.space_id,r.owner_id,r.visibility,r.team_id,JSON.stringify(r.tags),r.folder,r.title,r.filename,r.mime_type,r.file_size,r.sha256,r.source_asset_id,r.status,r.progress,r.stage,r.parsed_content,r.editor_content == null ? null : JSON.stringify(r.editor_content),r.parser_version,r.error,r.document_id,r.latest_job_id,r.created_at,r.updated_at]; }
function jobValues(j: ImportJobRecord): unknown[] { return [j.job_id,j.import_id,j.status,j.attempts,j.max_attempts,j.generation,j.requested_by,j.space_id,j.config_fingerprint,j.worker_id,j.lease_expires_at,j.next_run_at,j.error,j.created_at,j.started_at,j.finished_at,j.updated_at]; }
function parseJsonObject(v: unknown): Record<string,unknown>|null { if(v&&typeof v==='object'&&!Array.isArray(v)) return v as Record<string,unknown>; if(typeof v!=='string') return null; try{return JSON.parse(v) as Record<string,unknown>;}catch{return null;} }
function parseTags(v: unknown): string[] { if(Array.isArray(v))return v.map(String); if(typeof v==='string')try{const p=JSON.parse(v) as unknown;return Array.isArray(p)?p.map(String):[];}catch{return [];} return []; }
function mapImport(r: Record<string,unknown>): DocumentImportRecord { return { import_id:String(r.import_id),space_id:String(r.space_id),owner_id:String(r.owner_id),visibility:r.visibility as Visibility,team_id:r.team_id==null?null:String(r.team_id),tags:parseTags(r.tags),folder:r.folder==null?null:String(r.folder),title:String(r.title),filename:String(r.filename),mime_type:String(r.mime_type),file_size:Number(r.file_size),sha256:String(r.sha256),source_asset_id:String(r.source_asset_id),status:r.status as DocumentImportRecord['status'],progress:Number(r.progress),stage:String(r.stage),parsed_content:String(r.parsed_content??''),editor_content:parseJsonObject(r.editor_content),parser_version:r.parser_version==null?null:String(r.parser_version),error:r.error==null?null:String(r.error),document_id:r.document_id==null?null:String(r.document_id),latest_job_id:r.latest_job_id==null?null:String(r.latest_job_id),created_at:new Date(r.created_at as string|Date),updated_at:new Date(r.updated_at as string|Date)}; }
function mapJob(r: Record<string,unknown>): ImportJobRecord { return { job_id:String(r.job_id),import_id:String(r.import_id),status:r.status as ImportJobRecord['status'],attempts:Number(r.attempts),max_attempts:Number(r.max_attempts),generation:Number(r.generation),requested_by:String(r.requested_by),space_id:String(r.space_id),config_fingerprint:String(r.config_fingerprint??''),worker_id:r.worker_id==null?null:String(r.worker_id),lease_expires_at:r.lease_expires_at==null?null:new Date(r.lease_expires_at as string|Date),next_run_at:new Date(r.next_run_at as string|Date),error:r.error==null?null:String(r.error),created_at:new Date(r.created_at as string|Date),started_at:r.started_at==null?null:new Date(r.started_at as string|Date),finished_at:r.finished_at==null?null:new Date(r.finished_at as string|Date),updated_at:new Date(r.updated_at as string|Date)}; }
