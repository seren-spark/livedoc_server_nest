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

  async enqueue(
    document: DocumentRecord,
    context: AccessContext,
    forceFull = false,
  ): Promise<DocumentMemoryJobRecord | null> {
    //抢任务 + 版本校验
    if (!this.config.documentMemoryEnabled || !document.content.trim()) return null;
    const now = new Date();
    const dedupeKey = `${document.doc_id}:${document.document_version}:${forceFull ? 'full' : 'incremental'}`;
    let job: DocumentMemoryJobRecord = {
      job_id: randomUUID().replaceAll('-', ''), doc_id: document.doc_id,
      document_version: document.document_version, generation: 1, status: 'queued', attempts: 0,
      max_attempts: this.config.documentMemoryMaxAttempts, requested_by: context.user_id,
      space_id: context.space_id, force_full: forceFull, dedupe_key: dedupeKey,
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

  async claimNext(workerId: string): Promise<DocumentMemoryJobRecord | null> {
    return this.store.claimNext(workerId);
  }

  async succeed(job: DocumentMemoryJobRecord): Promise<void> {
    await this.store.finish(job.job_id, 'succeeded');
  }

  async isActive(job: DocumentMemoryJobRecord): Promise<boolean> {
    return this.store.isRunning(job.job_id, job.generation);
  }

  async supersede(job: DocumentMemoryJobRecord): Promise<void> {
    await this.store.finish(job.job_id, 'superseded', {
      error: 'A newer document version exists',
    });
  }

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

  async cancelDocument(docId: string): Promise<void> {
    await this.store.cancelWhere({
      whereSql: 'doc_id=?',
      params: [docId],
      predicate: (job) => job.doc_id === docId,
    });
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.store.deleteWhere({
      whereSql: 'doc_id=?',
      params: [docId],
      predicate: (job) => job.doc_id === docId,
    });
  }
}
