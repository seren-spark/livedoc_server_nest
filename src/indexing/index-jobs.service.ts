import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppConfig } from "../config/app-config.js";
import type { AccessContext, IndexJobStatus } from "../common/types.js";
import { DatabaseService } from "../database/database.service.js";
import type { DocumentIndexRequest } from "../documents/document.types.js";
import { PersistentJobStore } from "../jobs/persistent-job-store.js";
import type { IndexJobRecord } from "./index-job.types.js";
import { IndexJobsRepository, mapIndexJob } from "./index-jobs.repository.js";

const ACTIVE: IndexJobStatus[] = ["queued", "running", "retry_wait"];

@Injectable()
export class IndexJobsService {
  private readonly jobs = new Map<string, IndexJobRecord>();
  private readonly store: PersistentJobStore<IndexJobRecord>;
  private readonly repository: IndexJobsRepository;

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    this.repository = new IndexJobsRepository(database);
    this.store = new PersistentJobStore({
      database: this.database,
      enabled: () => this.database.indexJobsEnabled,
      tableName: "index_jobs",
      leaseSeconds: () => this.config.indexJobLeaseSeconds,
      jobs: this.jobs,
      mapRow: mapIndexJob,
      hasDedupeKey: true,
    });
  }

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
      return this.repository.enqueue(job);
    } else this.jobs.set(job.job_id, job);
    return job;
  }

  async get(jobId: string): Promise<IndexJobRecord | null> {
    return this.store.get(jobId);
  }

  /**
   * 领取下一个任务
   * @param workerId 工作线程 ID
   * @returns 被领取的任务记录，或 null 表示没有任务可领取
   */
  async claimNext(workerId: string): Promise<IndexJobRecord | null> {
    // PersistentJobStore still claims MySQL jobs in a transaction with FOR UPDATE SKIP LOCKED.
    return this.store.claimNext(workerId);
  }

  async heartbeat(jobId: string, workerId: string, generation: number): Promise<boolean> {
    return this.store.heartbeat(jobId, workerId, generation);
  }

  async ownsLease(jobId: string, workerId: string, generation: number): Promise<boolean> {
    return this.store.ownsLease(jobId, workerId, generation);
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
      return this.retry(jobId, error, new Date(Date.now() + delay * 1000), workerId, generation);
    }
    return this.finish(jobId, "failed", error, workerId, generation);
  }

  async cancelDocument(docId: string): Promise<void> {
    await this.store.cancelWhere({
      whereSql: "doc_id=?",
      params: [docId],
      predicate: (job) => job.doc_id === docId,
      error: "Document deleted",
    });
  }

  async activeCount(spaceId: string): Promise<number> {
    return this.store.activeCountBySpace(spaceId);
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
    return this.repository.listByDocument(docId);
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
    workerId?: string,
    generation?: number,
  ): Promise<IndexJobRecord> {
    const job = await this.store.finish(jobId, "retry_wait", {
      error,
      nextRunAt,
      workerId,
      generation,
    });
    return job ?? this.require(jobId);
  }

  private async finish(
    jobId: string,
    status: IndexJobStatus,
    error: string | null = null,
    workerId?: string,
    generation?: number,
  ): Promise<IndexJobRecord> {
    const job = await this.store.finish(jobId, status, {
      error,
      workerId,
      generation,
    });
    return job ?? this.require(jobId);
  }

  private configFingerprint(): string {
    return this.config.configFingerprint;
  }
}
