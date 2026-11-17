/**
 * @file 索引任务队列。管理任务入队、租约续期、成功、失败、失效和重试。
 */
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppConfig } from "../config/app-config.js";
import type { AccessContext, IndexJobStatus } from "../common/types.js";
import { DatabaseService } from "../database/database.service.js";
import type { DocumentIndexRequest } from "../documents/document.types.js";
import { PersistentJobStore } from "../jobs/persistent-job-store.js";
import type { IndexJobRecord } from "./index-job.types.js";
import { IndexJobsRepository, mapIndexJob } from "./index-jobs.repository.js";
import type { EntityManager } from 'typeorm';

const ACTIVE: IndexJobStatus[] = ["queued", "running", "retry_wait"];

@Injectable()
export class IndexJobsService {
  private readonly jobs = new Map<string, IndexJobRecord>();
  private readonly store: PersistentJobStore<IndexJobRecord>;
  private readonly repository: IndexJobsRepository;

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param database 共享数据库服务。
   */
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

  /**
   * 对索引任务做重复检查后提交后台任务。
   *
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param _force 回调签名保留的参数，当前实现不使用。
   * @param manager 当前数据库事务执行器（可选）。
   * @returns 索引任务记录。
   */
  async enqueue(
    request: DocumentIndexRequest, // 要索引的文档快照（doc_id + document_version + 正文等）
    context: AccessContext, // 当前用户上下文（user_id / space_id / team_ids）
    _force = false,
    manager?: EntityManager,
  ): Promise<IndexJobRecord> {
    //1. 先去查"同一篇文档的同一个版本，当前是否已有活跃任务"。
    // Reuse the same version history for active-job deduplication and generation.
    const previous = (manager ? [] : await this.forDocument(request.doc_id)).filter(
      (item) => item.document_version === request.document_version,
    );
    const duplicate = previous.find((item) => ACTIVE.includes(item.status));
    if (duplicate) return duplicate;
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
    //判断是否启用 MySQL 任务队列。 indexJobsEnabled 来自 DatabaseService ，如果数据库不可用就走后面的内存 Map 退路。
    if (this.database.indexJobsEnabled) {
      return this.repository.enqueue(job, manager);
    } else this.jobs.set(job.job_id, job);
    return job;
  }

  /**
   * 按标识读取索引任务。
   *
   * @param jobId 后台任务标识。
   * @returns 索引任务记录；未找到或不可用时可能为空。
   */
  async get(jobId: string): Promise<IndexJobRecord | null> {
    return this.store.get(jobId);
  }

  /**
   * 领取下一个任务
   * @param workerId 工作线程 ID
   * @returns 被领取的任务记录，或 null 表示没有任务可领取
   *
   * @param targetJobId targetJob 对应的唯一标识（可选）。
   */
  async claimNext(workerId: string, targetJobId?: string): Promise<IndexJobRecord | null> {
    // PersistentJobStore still claims MySQL jobs in a transaction with FOR UPDATE SKIP LOCKED.
    return this.store.claimNext(workerId, targetJobId);
  }

  /**
   * 续期当前 Worker 的任务租约。
   *
   * @param jobId 后台任务标识。
   * @param workerId 当前执行 Worker 的标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @returns 条件是否满足的判断结果。
   */
  async heartbeat(jobId: string, workerId: string, generation: number): Promise<boolean> {
    return this.store.heartbeat(jobId, workerId, generation);
  }

  /**
   * 检查当前 Worker 与执行代次是否仍持有任务租约。
   *
   * @param jobId 后台任务标识。
   * @param workerId 当前执行 Worker 的标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @returns 条件是否满足的判断结果。
   */
  async ownsLease(jobId: string, workerId: string, generation: number): Promise<boolean> {
    return this.store.ownsLease(jobId, workerId, generation);
  }

  /**
   * 将当前执行任务标记为成功，并保存结果状态。
   *
   * @param jobId 后台任务标识。
   * @param workerId 当前执行 Worker 的标识（可选）。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入（可选）。
   * @returns 索引任务记录。
   */
  async succeed(jobId: string, workerId?: string, generation?: number): Promise<IndexJobRecord> {
    return this.finish(jobId, "succeeded", null, workerId, generation);
  }

  /**
   * 将已被新版本替代的任务标记为失效。
   *
   * @param jobId 后台任务标识。
   * @param workerId 当前执行 Worker 的标识（可选）。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入（可选）。
   * @returns 索引任务记录。
   */
  async supersede(jobId: string, workerId?: string, generation?: number): Promise<IndexJobRecord> {
    return this.finish(jobId, "superseded", null, workerId, generation);
  }

  /**
   * 记录任务失败原因，并根据剩余次数安排重试或结束。
   *
   * @param jobId 后台任务标识。
   * @param error 本次操作捕获的异常。
   * @param workerId 当前执行 Worker 的标识（可选）。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入（可选）。
   * @returns 索引任务记录。
   */
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

  /**
   * 取消指定文档尚未结束的后台任务。
   *
   * @param docId 知识文档标识。
   */
  async cancelDocument(docId: string): Promise<void> {
    await this.store.cancelWhere({
      whereSql: "doc_id=?",
      params: [docId],
      predicate: (job) => job.doc_id === docId,
      error: "Document deleted",
    });
  }

  /**
   * 统计当前范围内尚未结束的任务数量。
   *
   * @param spaceId space 对应的唯一标识。
   * @returns 计算得到的数值。
   */
  async activeCount(spaceId: string): Promise<number> {
    return this.store.activeCountBySpace(spaceId);
  }
  /**
   * 删除指定文档对应的数据及关联记录。
   *
   * @param docId 知识文档标识。
   */
  async deleteDocument(docId:string):Promise<void> {
    await this.store.deleteWhere({whereSql:'doc_id=?',params:[docId],predicate:job=>job.doc_id===docId});
  }

  // 获取文档所有索引任务（包括已完成）
  /**
   * 获取文档所有索引任务（包括已完成）
   *
   * @param docId 知识文档标识。
   * @returns 索引任务记录列表。
   */
  private async forDocument(docId: string): Promise<IndexJobRecord[]> {
    if (!this.database.indexJobsEnabled)
      return [...this.jobs.values()].filter((item) => item.doc_id === docId);
    return this.repository.listByDocument(docId);
  }

  /**
   * 读取必需的索引任务，不存在时抛出错误。
   *
   * @param jobId 后台任务标识。
   * @returns 索引任务记录。
   */
  private async require(jobId: string): Promise<IndexJobRecord> {
    const job = await this.get(jobId);
    if (!job) throw new Error(`Index job not found: ${jobId}`);
    return job;
  }

  /**
   * 检查当前状态后重新提交失败的任务。
   *
   * @param jobId 后台任务标识。
   * @param error 本次操作捕获的异常。
   * @param nextRunAt nextRunAt 参数（Date）。
   * @param workerId 当前执行 Worker 的标识（可选）。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入（可选）。
   * @returns 索引任务记录。
   */
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

  /**
   * 通过共享任务存储更新索引终态，若租约已变则读取当前任务状态。
   *
   * @param jobId 后台任务标识。
   * @param status 本次需要记录或切换到的状态。
   * @param error 本次操作捕获的异常。
   * @param workerId 当前执行 Worker 的标识（可选）。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入（可选）。
   * @returns 索引任务记录。
   */
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

}
