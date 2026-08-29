import { Injectable } from '@nestjs/common';
import type { IndexJobRecord } from './index-job.types.js';
import { IndexJobsService } from './index-jobs.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { VectorStoreService } from '../retrieval/vector-store.service.js';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class IndexWorkerService {
  constructor(
    private readonly jobs: IndexJobsService,
    private readonly documents: DocumentsService,
    private readonly retrieval: RetrievalService,
    private readonly store: VectorStoreService,
    private readonly config: AppConfig,
  ) {}
  /**
   * 索引工作线程一次运行
   * @param workerId 工作线程 ID
   * @returns 索引任务记录
   */
  async runOnce(workerId: string): Promise<IndexJobRecord | null> {
    //抢占任务， 调用 claimNext 从 index_jobs 表抢一个任务。
    // 没抢到直接返回，外层 worker.ts 会 sleep 后再试。
    const job = await this.jobs.claimNext(workerId);
    if (!job) return null;
    const heartbeat = setInterval(
      () => void this.jobs.heartbeat(job.job_id, workerId, job.generation),
      Math.max(1_000, Math.floor((job.lease_expires_at!.getTime() - Date.now()) / 3)),
    );
    try {
      if (job.config_fingerprint !== this.config.configFingerprint) {
        throw new Error(
          `Index worker configuration fingerprint mismatch: job=${job.config_fingerprint} worker=${this.config.configFingerprint}`,
        );
      }
      //读当前文档最新状态。
      const current = await this.documents.get(job.doc_id);
      //文档已经被删了。但任务里可能还有快照，保险起见：
      //1.deleteDocumentVersion删除 Qdrant 里该版本 points
      //2.supersede(job.job_id) ：把任务标记为 superseded （被替代/失效），不是 failed 。
      if (!current) {
        await this.store.deleteDocumentVersion(job.doc_id, job.document_version);
        return this.jobs.supersede(job.job_id, workerId, job.generation);
      }
      //如果不相等，说明用户已经更新过文档，产生了新版本。这个旧任务不需要执行，直接 supersede
      if (current.document_version !== job.document_version) return this.jobs.supersede(job.job_id, workerId, job.generation);
      //把文档的 index_status 从 queued 改成 indexing ，让前端轮询看到"正在索引"。
      await this.documents.markIndexing(job.doc_id);
      //job.request_payload ：任务入队时的文档快照（title/content/visibility 等）。
      // 第二个参数 false ：表示 只写入 Qdrant，不激活 。即这些 points 的 is_active 是 false，检索时不会命中。
      // retrieval.indexDocument 内部会做：
      // 1. Markdown 标题感知分块（§5）
      // 2. 生成 Dense + Sparse 向量（§6）
      // 3. 批量写入 Qdrant points
      const chunkCount = await this.retrieval.indexDocument(job.request_payload, false);
      //索引做完了，再读一次文档最新版本。
      const latest = await this.documents.get(job.doc_id);
      //如果文档不存在了，或者版本又不一致了（说明索引过程中用户又更新了），那么：
      // 1. deleteDocumentVersion ：删掉刚才写入的、未激活的 points，避免占用空间和被误激活。
      // 2. supersede ：任务标记失效。
      if (!latest || latest.document_version !== job.document_version) {
        await this.store.deleteDocumentVersion(job.doc_id, job.document_version);
        return this.jobs.supersede(job.job_id, workerId, job.generation);
      }
      if (!(await this.jobs.ownsLease(job.job_id, workerId, job.generation))) {
        await this.store.deleteDocumentVersion(job.doc_id, job.document_version);
        return this.jobs.get(job.job_id);
      }
      //两次检查都通过，正式把该版本的 points 标记为 is_active=true ，同时让旧版本 points 失活。
      await this.store.activateDocumentVersion(job.doc_id, job.document_version);
      //更新文档状态：
      //index_status = 'ready'  active_index_version = job.document_version
      //chunk_count = chunkCount   indexed_at = now
      await this.documents.markReady(job.doc_id, chunkCount, job.document_version);
      return this.jobs.succeed(job.job_id, workerId, job.generation);
    } catch (error) {
      const updated = await this.jobs.fail(
        job.job_id,
        describeWorkerError(error),
        workerId,
        job.generation,
      );
      const current = await this.documents.get(job.doc_id);
      if (current?.document_version === job.document_version) {
        if (updated.status === 'failed') await this.documents.markFailed(job.doc_id, updated.error ?? 'Indexing failed');
        else if (updated.status === 'retry_wait') await this.documents.markQueued(job.doc_id, job.job_id);
      }
      return updated;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function describeWorkerError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const apiError = error as Error & {
    status?: unknown;
    statusText?: unknown;
    data?: unknown;
  };
  const details: string[] = [error.message];
  if (apiError.status != null) details.push(`status=${String(apiError.status)}`);
  if (apiError.statusText && apiError.statusText !== error.message) {
    details.push(`statusText=${String(apiError.statusText)}`);
  }
  if (apiError.data != null) {
    try {
      details.push(`response=${JSON.stringify(apiError.data)}`);
    } catch {
      details.push(`response=${String(apiError.data)}`);
    }
  }
  return details.join('; ');
}
