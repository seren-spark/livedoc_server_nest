import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppConfig } from "../config/app-config.js";
import type { AccessContext, IndexJobStatus } from "../common/types.js";
import { DatabaseService } from "../database/database.service.js";
import type { DocumentIndexRequest } from "../documents/document.types.js";
import type { IndexJobRecord } from "./index-job.types.js";

const ACTIVE: IndexJobStatus[] = ["queued", "running", "retry_wait"];

@Injectable()
export class IndexJobsService {
  private readonly jobs = new Map<string, IndexJobRecord>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {}

  async enqueue(
    request: DocumentIndexRequest, // 要索引的文档快照（doc_id + document_version + 正文等）
    context: AccessContext, // 当前用户上下文（user_id / space_id / team_ids）
    _force = false,
  ): Promise<IndexJobRecord> {
    //1. 先去查"同一篇文档的同一个版本，当前是否已有活跃任务"。
    const duplicate = await this.activeFor(
      request.doc_id,
      request.document_version,
    );
    if (duplicate) return duplicate;
    //查该文档全部历史任务，再过滤出 同版本 的任务。目的是取 generation 的最大值。
    const previous = (await this.forDocument(request.doc_id)).filter(
      (item) => item.document_version === request.document_version,
    );
    const now = new Date();
    //dedupeKey 是数据库去重键，语义是"同一篇文档的同一版本最多只能有一个未完成的任务"。
    const dedupeKey = `${request.doc_id}:${request.document_version}`;
    //构造一个完整的 IndexJobRecord 对象
    const job: IndexJobRecord = {
      job_id: randomUUID().replaceAll("-", ""),
      doc_id: request.doc_id, //任务针对的文档版本
      document_version: request.document_version,
      //同一 doc+version 的第几次入队。 previous 中找最大 generation 再加 1
      //generation 的作用： 假设同一文档同一版本因为某种原因被入队了多次（虽然前面有去重）， generation 能区分"第几次尝试创建"。任务完成后 dedupe_key 会被清空，所以未来再查 previous 还能看到历史 generation。
      generation: Math.max(0, ...previous.map((item) => item.generation)) + 1,
      status: "queued",
      attempts: 0,
      max_attempts: this.config.indexJobMaxAttempts,
      //谁发起的
      requested_by: context.user_id,
      //哪个空间
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
    //判断是否启用 MySQL 任务队列。 indexJobsEnabled 来自 DatabaseService ，如果数据库不可用就走后面的内存 Map 退路。
    if (this.database.indexJobsEnabled) {
      const runner = this.database.source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        //用 SELECT ... FOR UPDATE 锁住 dedupeKey 对应的行。
        //- 如果数据库里已经有这个 dedupe_key，当前事务会拿到这个行的 写锁 。
        //- 另一个并发请求同时跑 SELECT ... FOR UPDATE 时，会被阻塞，等当前事务提交或回滚。
        //- 这是数据库层面的并发控制。
        const existing = (await runner.query(
          "SELECT * FROM index_jobs WHERE dedupe_key=? LIMIT 1 FOR UPDATE",
          [dedupeKey],
        )) as Record<string, unknown>[];
        //如果已经存在，说明另一个请求先一步入队了。当前请求直接提交空事务并返回已存在的任务，不再 INSERT。
        if (existing[0]) {
          await runner.commitTransaction();
          return mapJob(existing[0]);
        }
        //重新查数据库里的 generation 最大值。为什么要重新查？因为前面 previous 是应用层查的，可能并发里有新任务已经 INSERT 了，数据库里才是最准的。
        const generations = (await runner.query(
          `SELECT COALESCE(MAX(generation), 0) AS generation FROM index_jobs
           WHERE doc_id=? AND document_version=?`,
          [request.doc_id, request.document_version],
        )) as Array<{ generation: number | string }>;
        job.generation = Number(generations[0]?.generation ?? 0) + 1;
        //真正 INSERT 任务到 index_jobs 表。
        // 注意 request_payload 是对象，要 JSON.stringify(...) 变成字符串存进去。后面 mapJob 会 JSON.parse 还原。
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

        //提交事务。此时锁释放，其他并发请求才能继续。
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        const existing = await this.database.query<Record<string, unknown>>(
          "SELECT * FROM index_jobs WHERE dedupe_key=? LIMIT 1",
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
    const rows = await this.database.query<Record<string, unknown>>(
      "SELECT * FROM index_jobs WHERE job_id = ?",
      [jobId],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async claimNext(workerId: string): Promise<IndexJobRecord | null> {
    if (!this.database.indexJobsEnabled) {
      const now = Date.now();
      const job = [...this.jobs.values()]
        .filter(
          (item) =>
            ((item.status === "queued" || item.status === "retry_wait") &&
              (!item.next_run_at || item.next_run_at.getTime() <= now)) ||
            (item.status === "running" &&
              Boolean(
                item.lease_expires_at && item.lease_expires_at.getTime() <= now,
              )),
        )
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0];
      if (!job) return null;
      const claimed = {
        ...job,
        status: "running" as const,
        attempts: job.attempts + 1,
        worker_id: workerId,
        started_at: job.started_at ?? new Date(),
        lease_expires_at: new Date(
          now + this.config.indexJobLeaseSeconds * 1000,
        ),
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
      const lease = new Date(
        Date.now() + this.config.indexJobLeaseSeconds * 1000,
      );
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

  async heartbeat(jobId: string, workerId: string, generation: number): Promise<boolean> {
    const lease = new Date(Date.now() + this.config.indexJobLeaseSeconds * 1000);
    if (this.database.indexJobsEnabled) {
      const result = await this.database.source.query(
        `UPDATE index_jobs SET lease_expires_at=?, updated_at=UTC_TIMESTAMP(6)
         WHERE job_id=? AND worker_id=? AND generation=? AND status='running'`,
        [lease, jobId, workerId, generation],
      );
      return Number(result?.affectedRows ?? 0) === 1;
    }
    const job = this.jobs.get(jobId);
    if (!job || job.worker_id !== workerId || job.generation !== generation || job.status !== 'running') return false;
    this.jobs.set(jobId, { ...job, lease_expires_at: lease, updated_at: new Date() });
    return true;
  }

  async ownsLease(jobId: string, workerId: string, generation: number): Promise<boolean> {
    const job = await this.get(jobId);
    return Boolean(
      job &&
      job.status === 'running' &&
      job.worker_id === workerId &&
      job.generation === generation &&
      job.lease_expires_at &&
      job.lease_expires_at.getTime() > Date.now(),
    );
  }

  async succeed(jobId: string, workerId?: string, generation?: number): Promise<IndexJobRecord> {
    return this.finish(jobId, "succeeded", null, workerId, generation);
  }

  async supersede(jobId: string, workerId?: string, generation?: number): Promise<IndexJobRecord> {
    return this.finish(jobId, "superseded", null, workerId, generation);
  }

  async fail(jobId: string, error: string, workerId?: string, generation?: number): Promise<IndexJobRecord> {
    const job = await this.require(jobId);
    if (workerId && (job.worker_id !== workerId || job.generation !== generation)) return job;
    if (job.attempts < job.max_attempts) {
      const delays = [30, 120, 600];
      const delay =
        delays[Math.min(job.attempts - 1, delays.length - 1)] ?? 600;
      return this.retry(jobId, error, new Date(Date.now() + delay * 1000));
    }
    return this.finish(jobId, "failed", error, workerId, generation);
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
          status: "canceled",
          error: "Document deleted",
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
      return [...this.jobs.values()].filter(
        (item) => item.space_id === spaceId && ACTIVE.includes(item.status),
      ).length;
    }
    const rows = await this.database.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM index_jobs WHERE space_id=? AND status IN ('queued','running','retry_wait')`,
      [spaceId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // 检查文档是否有活跃索引任务（queued/running/retry_wait）
  private async activeFor(
    docId: string,
    version: number,
  ): Promise<IndexJobRecord | null> {
    const jobs = await this.forDocument(docId);
    return (
      jobs.find(
        (item) =>
          item.document_version === version && ACTIVE.includes(item.status),
      ) ?? null
    );
  }

  // 获取文档所有索引任务（包括已完成）
  private async forDocument(docId: string): Promise<IndexJobRecord[]> {
    if (!this.database.indexJobsEnabled)
      return [...this.jobs.values()].filter((item) => item.doc_id === docId);
    return (
      await this.database.query<Record<string, unknown>>(
        "SELECT * FROM index_jobs WHERE doc_id = ?",
        [docId],
      )
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
      status: "retry_wait" as const,
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
    workerId?: string,
    generation?: number,
  ): Promise<IndexJobRecord> {
    const current = await this.require(jobId);
    if (workerId && (current.worker_id !== workerId || current.generation !== generation)) return current;
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
      const where = workerId
        ? 'job_id=? AND worker_id=? AND generation=? AND status=\'running\''
        : 'job_id=?';
      const params = workerId
        ? [status, next.error, now, now, jobId, workerId, generation]
        : [status, next.error, now, now, jobId];
      const result = await this.database.source.query(
        `UPDATE index_jobs SET status=?, error=?, worker_id=NULL, lease_expires_at=NULL,
         dedupe_key=NULL, finished_at=?, updated_at=? WHERE ${where}`,
        params,
      );
      if (workerId && Number(result?.affectedRows ?? 0) !== 1) return this.require(jobId);
    } else this.jobs.set(jobId, next);
    return next;
  }

  private configFingerprint(): string {
    return this.config.configFingerprint;
  }
}

function parsePayload(value: unknown): DocumentIndexRequest {
  if (typeof value === "string")
    return JSON.parse(value) as DocumentIndexRequest;
  return value as DocumentIndexRequest;
}

function mapJob(row: Record<string, unknown>): IndexJobRecord {
  const date = (value: unknown) =>
    value == null ? null : new Date(value as string | number | Date);
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
