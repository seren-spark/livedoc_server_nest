import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessContext } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import { PersistentJobStore } from '../jobs/persistent-job-store.js';
import type { DocumentRecord } from './document.types.js';
import { DocumentMemoryService } from './document-memory.service.js';
import type { DocumentMemoryJobRecord } from './document-memory.types.js';

@Injectable()
export class DocumentMemoryJobsService {
  private readonly jobs = new Map<string, DocumentMemoryJobRecord>();
  private readonly store: PersistentJobStore<DocumentMemoryJobRecord>;

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly profiles: DocumentMemoryService,
  ) {
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
      const runner = this.database.source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const duplicate = (await runner.query(
          'SELECT * FROM document_memory_jobs WHERE dedupe_key=? LIMIT 1 FOR UPDATE',
          [dedupeKey],
        )) as Record<string, unknown>[];
        if (duplicate[0]) {
          await runner.commitTransaction();
          return mapMemoryJob(duplicate[0]);
        }
        await runner.query(
          `UPDATE document_memory_jobs SET status='superseded',dedupe_key=NULL,
           worker_id=NULL,lease_expires_at=NULL,finished_at=?,updated_at=?
          WHERE doc_id=? AND (document_version<? OR (document_version=? AND dedupe_key<>?))
            AND status IN ('queued','running','retry_wait')`,
          [now, now, document.doc_id, document.document_version, document.document_version, dedupeKey],
        );
        const generations = (await runner.query(
          'SELECT COALESCE(MAX(generation),0) AS generation FROM document_memory_jobs WHERE doc_id=? AND document_version=?',
          [document.doc_id, document.document_version],
        )) as Array<{ generation: number | string }>;
        job = { ...job, generation: Number(generations[0]?.generation ?? 0) + 1 };
        await runner.query(
          `INSERT INTO document_memory_jobs
            (job_id,doc_id,document_version,generation,status,attempts,max_attempts,
             requested_by,space_id,force_full,dedupe_key,next_run_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [job.job_id, job.doc_id, job.document_version, job.generation, job.status,
            job.attempts, job.max_attempts, job.requested_by, job.space_id,
            job.force_full, job.dedupe_key, job.next_run_at, job.created_at, job.updated_at],
        );
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
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

export function mapMemoryJob(row: Record<string, unknown>): DocumentMemoryJobRecord {
  return {
    job_id: String(row.job_id), doc_id: String(row.doc_id), document_version: Number(row.document_version),
    generation: Number(row.generation), status: row.status as DocumentMemoryJobRecord['status'],
    attempts: Number(row.attempts), max_attempts: Number(row.max_attempts),
    requested_by: String(row.requested_by), space_id: String(row.space_id),
    force_full: row.force_full === true || Number(row.force_full) === 1,
    dedupe_key: row.dedupe_key == null ? null : String(row.dedupe_key),
    worker_id: row.worker_id == null ? null : String(row.worker_id),
    lease_expires_at: row.lease_expires_at == null ? null : new Date(row.lease_expires_at as string | Date),
    next_run_at: row.next_run_at == null ? null : new Date(row.next_run_at as string | Date),
    error: row.error == null ? null : String(row.error), created_at: new Date(row.created_at as string | Date),
    started_at: row.started_at == null ? null : new Date(row.started_at as string | Date),
    finished_at: row.finished_at == null ? null : new Date(row.finished_at as string | Date),
    updated_at: new Date(row.updated_at as string | Date),
  };
}
