/**
 * @file 文档记忆任务队列。管理记忆提取任务的入队、领取、失效、完成和重试。
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessContext } from '../../common/types.js';
import { AppConfig } from '../../config/app-config.js';
import { DatabaseService } from '../../database/database.service.js';
import { PersistentJobStore } from '../../jobs/persistent-job-store.js';
import type { DocumentRecord } from '../document.types.js';
import { DocumentMemoryService } from './document-memory.service.js';
import type { DocumentMemoryJobRecord } from './document-memory.types.js';
import {
  DocumentMemoryJobRepository,
  mapMemoryJob,
} from './document-memory-job.repository.js';

@Injectable()
export class DocumentMemoryJobsService {
  private readonly jobs = new Map<string, DocumentMemoryJobRecord>();
  private readonly store: PersistentJobStore<DocumentMemoryJobRecord>;
  private readonly repository: DocumentMemoryJobRepository;

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param database 共享数据库服务。
   * @param profiles DocumentMemoryService 依赖实例。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly profiles: DocumentMemoryService,
  ) {
    this.repository = new DocumentMemoryJobRepository(database);
    this.store = new PersistentJobStore({
      database: this.database,
      enabled: () => this.database.memoryEnabled,
      tableName: 'document_memory_jobs',
      leaseSeconds: () => this.config.documentMemoryLeaseSeconds,
      jobs: this.jobs,
      mapRow: mapMemoryJob,
      hasDedupeKey: true,
    });
  }

  /**
   * 对记忆提取任务做重复检查后提交后台任务。
   *
   * @param document 当前知识文档记录。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 文档记忆提取任务；未找到或不可用时可能为空。
   */
  async enqueue(
    document: DocumentRecord,
    context: AccessContext,
  ): Promise<DocumentMemoryJobRecord | null> {
    //抢任务 + 版本校验
    if (!this.config.documentMemoryEnabled || !document.content.trim()) return null;
    const now = new Date();
    const dedupeKey = `${document.doc_id}:${document.document_version}`;
    //构造初始 job 对象
    let job: DocumentMemoryJobRecord = {
      job_id: randomUUID().replaceAll('-', ''), doc_id: document.doc_id,
      document_version: document.document_version, generation: 1, status: 'queued', attempts: 0,
      max_attempts: this.config.documentMemoryMaxAttempts, requested_by: context.user_id,
      space_id: context.space_id, dedupe_key: dedupeKey,
      worker_id: null, lease_expires_at: null, next_run_at: now, error: null,
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    };
    if (this.database.memoryEnabled) {
      job = await this.repository.enqueue(job);
    } else {
      for (const [id, old] of this.jobs) {
        if (old.doc_id === document.doc_id &&
          (old.document_version < document.document_version ||
            (old.document_version === document.document_version && old.dedupe_key !== dedupeKey)) &&
          ['queued', 'running', 'retry_wait'].includes(old.status)) {
          this.jobs.set(id, { ...old, status: 'superseded', dedupe_key: null, updated_at: now, finished_at: now });
        }
      }
      const duplicate = [...this.jobs.values()].find((item) => item.dedupe_key === dedupeKey);
      if (duplicate) return duplicate;
      job.generation = Math.max(0, ...[...this.jobs.values()]
        .filter((item) => item.doc_id === document.doc_id && item.document_version === document.document_version)
        .map((item) => item.generation)) + 1;
      this.jobs.set(job.job_id, job);
    }
    await this.profiles.markPending(document);
    return job;
  }

  /**
   * 领取下一条可执行任务，并取得对应执行代次与租约。
   *
   * @param workerId 当前执行 Worker 的标识。
   * @returns 文档记忆提取任务；未找到或不可用时可能为空。
   */
  async claimNext(workerId: string): Promise<DocumentMemoryJobRecord | null> {
    return this.store.claimNext(workerId);
  }

  /**
   * 将当前执行任务标记为成功，并保存结果状态。
   *
   * @param job 当前后台任务记录。
   */
  async succeed(job: DocumentMemoryJobRecord): Promise<void> {
    await this.store.finish(job.job_id, 'succeeded');
  }

  /**
   * 判断记录或任务是否仍处于有效运行状态。
   *
   * @param job 当前后台任务记录。
   * @returns 条件是否满足的判断结果。
   */
  async isActive(job: DocumentMemoryJobRecord): Promise<boolean> {
    return this.store.isRunning(job.job_id, job.generation);
  }

  /**
   * 将已被新版本替代的任务标记为失效。
   *
   * @param job 当前后台任务记录。
   */
  async supersede(job: DocumentMemoryJobRecord): Promise<void> {
    await this.store.finish(job.job_id, 'superseded', {
      error: 'A newer document version exists',
    });
  }

  /**
   * 记录任务失败原因，并根据剩余次数安排重试或结束。
   *
   * @param job 当前后台任务记录。
   * @param error 本次操作捕获的异常。
   * @returns 条件是否满足的判断结果。
   */
  async fail(job: DocumentMemoryJobRecord, error: string): Promise<boolean> {
    const terminal = job.attempts >= job.max_attempts;
    const delays = [30, 120, 600];
    const delay = delays[Math.min(Math.max(job.attempts - 1, 0), delays.length - 1)]!;
    await this.store.finish(job.job_id, terminal ? 'failed' : 'retry_wait', {
      error,
      nextRunAt: terminal ? null : new Date(Date.now() + delay * 1000),
    });
    return terminal;
  }

  /**
   * 取消指定文档尚未结束的后台任务。
   *
   * @param docId 知识文档标识。
   */
  async cancelDocument(docId: string): Promise<void> {
    await this.store.cancelWhere({
      whereSql: 'doc_id=?',
      params: [docId],
      predicate: (job) => job.doc_id === docId,
    });
  }

  /**
   * 删除指定文档对应的数据及关联记录。
   *
   * @param docId 知识文档标识。
   */
  async deleteDocument(docId: string): Promise<void> {
    await this.store.deleteWhere({
      whereSql: 'doc_id=?',
      params: [docId],
      predicate: (job) => job.doc_id === docId,
    });
  }
}
