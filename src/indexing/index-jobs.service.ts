import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config.js';
import type { AccessContext, IndexJobStatus } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import type { DocumentIndexRequest } from '../documents/document.types.js';
import type { IndexJobRecord } from './index-job.types.js';

const ACTIVE: IndexJobStatus[] = ['queued', 'running', 'retry_wait'];

@Injectable()
export class IndexJobsService {
  private readonly jobs = new Map<string, IndexJobRecord>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {}

  async enqueue(
    request: DocumentIndexRequest,
    context: AccessContext,
    _force = false,
  ): Promise<IndexJobRecord> {
    const duplicate = await this.activeFor(request.doc_id, request.document_version);
    if (duplicate) return duplicate;
    const previous = (await this.forDocument(request.doc_id)).filter(
      (item) => item.document_version === request.document_version,
    );
    const now = new Date();
    const dedupeKey = `${request.doc_id}:${request.document_version}`;
    const job: IndexJobRecord = {
      job_id: randomUUID().replaceAll('-', ''),
      doc_id: request.doc_id,
      document_version: request.document_version,
      generation: Math.max(0, ...previous.map((item) => item.generation)) + 1,
      status: 'queued',
      attempts: 0,
      max_attempts: this.config.indexJobMaxAttempts,
      requested_by: context.user_id,
      space_id: context.space_id,
      request_payload: request,
      config_fingerprint: this.configFingerprint(),
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
    if (this.database.indexJobsEnabled) {
      const runner = this.database.source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const existing = (await runner.query(
          'SELECT * FROM index_jobs WHERE dedupe_key=? LIMIT 1 FOR UPDATE',
          [dedupeKey],
        )) as Record<string, unknown>[];
        if (existing[0]) {
          await runner.commitTransaction();
          return mapJob(existing[0]);
        }
        const generations = (await runner.query(
          `SELECT COALESCE(MAX(generation), 0) AS generation FROM index_jobs
           WHERE doc_id=? AND document_version=?`,
          [request.doc_id, request.document_version],
        )) as Array<{ generation: number | string }>;
        job.generation = Number(generations[0]?.generation ?? 0) + 1;
        await runner.query(
          `INSERT INTO index_jobs
            (job_id, doc_id, document_version, generation, status, attempts, max_attempts,
             requested_by, space_id, request_payload, config_fingerprint, dedupe_key,
             next_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            job.job_id,
            job.doc_id,
            job.document_version,
            job.generation,
            job.max_attempts,
            job.requested_by,
            job.space_id,
            JSON.stringify(job.request_payload),
            job.config_fingerprint,
            job.dedupe_key,
            job.next_run_at,
            now,
            now,
          ],
        );
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        const existing = await this.database.query<Record<string, unknown>>(
          'SELECT * FROM index_jobs WHERE dedupe_key=? LIMIT 1',
          [dedupeKey],
        );
        if (existing[0]) return mapJob(existing[0]);
        throw error;
      } finally {
        await runner.release();
      }
    } else this.jobs.set(job.job_id, job);
    return job;
  }

  async get(jobId: string): Promise<IndexJobRecord | null> {
    if (!this.database.indexJobsEnabled) return this.jobs.get(jobId) ?? null;
    const rows = await this.database.query<Record<string, unknown>>('SELECT * FROM index_jobs WHERE job_id = ?', [jobId]);
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async claimNext(workerId: string): Promise<IndexJobRecord | null> {
    if (!this.database.indexJobsEnabled) {
      const now = Date.now();
      const job = [...this.jobs.values()]
        .filter(
          (item) =>
            ((item.status === 'queued' || item.status === 'retry_wait') &&
              (!item.next_run_at || item.next_run_at.getTime() <= now)) ||
            (item.status === 'running' && Boolean(item.lease_expires_at && item.lease_expires_at.getTime() <= now)),
        )
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0];
      if (!job) return null;
      const claimed = {
        ...job,
        status: 'running' as const,
        attempts: job.attempts + 1,
        worker_id: workerId,
        started_at: job.started_at ?? new Date(),
        lease_expires_at: new Date(now + this.config.indexJobLeaseSeconds * 1000),
        updated_at: new Date(),
      };
      this.jobs.set(job.job_id, claimed);
      return claimed;
    }

    const runner = this.database.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const rows = (await runner.query(
        `SELECT * FROM index_jobs
         WHERE
           (status IN ('queued','retry_wait') AND (next_run_at IS NULL OR next_run_at <= UTC_TIMESTAMP(6)))
           OR (status='running' AND lease_expires_at <= UTC_TIMESTAMP(6))
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )) as Record<string, unknown>[];
      const row = rows[0];
      if (!row) {
        await runner.commitTransaction();
        return null;
      }
      const lease = new Date(Date.now() + this.config.indexJobLeaseSeconds * 1000);
      await runner.query(
        `UPDATE index_jobs SET status='running', attempts=attempts+1, worker_id=?,
         started_at=COALESCE(started_at, UTC_TIMESTAMP(6)), lease_expires_at=?, updated_at=UTC_TIMESTAMP(6)
         WHERE job_id=?`,
        [workerId, lease, row.job_id],
      );
      await runner.commitTransaction();
      return this.get(String(row.job_id));
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async succeed(jobId: string): Promise<IndexJobRecord> {
    return this.finish(jobId, 'succeeded');
  }

  async supersede(jobId: string): Promise<IndexJobRecord> {
    return this.finish(jobId, 'superseded');
  }

  async fail(jobId: string, error: string): Promise<IndexJobRecord> {
    const job = await this.require(jobId);
    if (job.attempts < job.max_attempts) {
      const delays = [30, 120, 600];
      const delay = delays[Math.min(job.attempts - 1, delays.length - 1)] ?? 600;
      return this.retry(jobId, error, new Date(Date.now() + delay * 1000));
    }
    return this.finish(jobId, 'failed', error);
  }

  async cancelDocument(docId: string): Promise<void> {
    if (this.database.indexJobsEnabled) {
      await this.database.query(
        `UPDATE index_jobs SET status='canceled', error='Document deleted', worker_id=NULL,
         lease_expires_at=NULL, dedupe_key=NULL, finished_at=UTC_TIMESTAMP(6), updated_at=UTC_TIMESTAMP(6)
         WHERE doc_id=? AND status IN ('queued','running','retry_wait')`,
        [docId],
      );
      return;
    }
    for (const job of this.jobs.values()) {
      if (job.doc_id === docId && ACTIVE.includes(job.status)) {
        const now = new Date();
        this.jobs.set(job.job_id, {
          ...job,
          status: 'canceled',
          error: 'Document deleted',
          worker_id: null,
          lease_expires_at: null,
          dedupe_key: null,
          finished_at: now,
          updated_at: now,
        });
      }
    }
  }

  async activeCount(spaceId: string): Promise<number> {
    if (!this.database.indexJobsEnabled) {
      return [...this.jobs.values()].filter((item) => item.space_id === spaceId && ACTIVE.includes(item.status)).length;
    }
    const rows = await this.database.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM index_jobs WHERE space_id=? AND status IN ('queued','running','retry_wait')`,
      [spaceId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async activeFor(docId: string, version: number): Promise<IndexJobRecord | null> {
    const jobs = await this.forDocument(docId);
    return jobs.find((item) => item.document_version === version && ACTIVE.includes(item.status)) ?? null;
  }

  private async forDocument(docId: string): Promise<IndexJobRecord[]> {
    if (!this.database.indexJobsEnabled) return [...this.jobs.values()].filter((item) => item.doc_id === docId);
    return (
      await this.database.query<Record<string, unknown>>('SELECT * FROM index_jobs WHERE doc_id = ?', [docId])
    ).map(mapJob);
  }

  private async require(jobId: string): Promise<IndexJobRecord> {
    const job = await this.get(jobId);
    if (!job) throw new Error(`Index job not found: ${jobId}`);
    return job;
  }

  private async retry(
    jobId: string,
    error: string,
    nextRunAt: Date,
  ): Promise<IndexJobRecord> {
    const current = await this.require(jobId);
    const next = {
      ...current,
      status: 'retry_wait' as const,
      error: error.slice(0, 2000),
      worker_id: null,
      next_run_at: nextRunAt,
      lease_expires_at: null,
      updated_at: new Date(),
    };
    if (this.database.indexJobsEnabled) {
      await this.database.query(
        `UPDATE index_jobs SET status='retry_wait', error=?, worker_id=NULL, next_run_at=?,
         lease_expires_at=NULL, updated_at=UTC_TIMESTAMP(6) WHERE job_id=?`,
        [next.error, nextRunAt, jobId],
      );
    } else this.jobs.set(jobId, next);
    return next;
  }

  private async finish(
    jobId: string,
    status: IndexJobStatus,
    error: string | null = null,
  ): Promise<IndexJobRecord> {
    const current = await this.require(jobId);
    const now = new Date();
    const next: IndexJobRecord = {
      ...current,
      status,
      error: error ? error.slice(0, 2000) : null,
      worker_id: null,
      lease_expires_at: null,
      dedupe_key: null,
      finished_at: now,
      updated_at: now,
    };
    if (this.database.indexJobsEnabled) {
      await this.database.query(
        `UPDATE index_jobs SET status=?, error=?, worker_id=NULL, lease_expires_at=NULL,
         dedupe_key=NULL, finished_at=?, updated_at=? WHERE job_id=?`,
        [status, next.error, now, now, jobId],
      );
    } else this.jobs.set(jobId, next);
    return next;
  }

  private configFingerprint(): string {
    const payload = [
      ['collection', this.config.qdrantCollection],
      ['embedding_model', this.config.embeddingModel],
      ['embedding_provider', this.config.embeddingProvider],
      ['sparse_model', this.config.sparseEmbeddingModel],
      ['sparse_provider', this.config.sparseEmbeddingProvider],
    ] as const;
    const serialized = `{${payload
      .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(', ')}}`;
    return createHash('sha256')
      .update(serialized)
      .digest('hex')
      .slice(0, 16);
  }
}

function parsePayload(value: unknown): DocumentIndexRequest {
  if (typeof value === 'string') return JSON.parse(value) as DocumentIndexRequest;
  return value as DocumentIndexRequest;
}

function mapJob(row: Record<string, unknown>): IndexJobRecord {
  const date = (value: unknown) => (value == null ? null : new Date(value as string | number | Date));
  return {
    job_id: String(row.job_id),
    doc_id: String(row.doc_id),
    document_version: Number(row.document_version),
    generation: Number(row.generation),
    status: row.status as IndexJobStatus,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    requested_by: String(row.requested_by),
    space_id: String(row.space_id),
    request_payload: parsePayload(row.request_payload),
    config_fingerprint: String(row.config_fingerprint),
    dedupe_key: row.dedupe_key == null ? null : String(row.dedupe_key),
    worker_id: row.worker_id == null ? null : String(row.worker_id),
    lease_expires_at: date(row.lease_expires_at),
    next_run_at: date(row.next_run_at),
    error: row.error == null ? null : String(row.error),
    created_at: new Date(row.created_at as string | number | Date),
    started_at: date(row.started_at),
    finished_at: date(row.finished_at),
    updated_at: new Date(row.updated_at as string | number | Date),
  };
}
