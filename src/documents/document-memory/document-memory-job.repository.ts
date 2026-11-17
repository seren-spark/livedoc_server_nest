/**
 * @file 文档记忆任务存储。保存提取任务与去重标识，将数据库行映射为任务对象。
 */
import { DatabaseService } from '../../database/database.service.js';
import type { DocumentMemoryJobRecord } from './document-memory.types.js';

const JOB_COLUMNS = `job_id,doc_id,document_version,generation,status,attempts,max_attempts,
  requested_by,space_id,dedupe_key,worker_id,lease_expires_at,next_run_at,
  error,created_at,started_at,finished_at,updated_at`;

export class DocumentMemoryJobRepository {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 对记忆提取任务做重复检查后提交后台任务。
   *
   * @param job 当前后台任务记录。
   * @returns 文档记忆提取任务。
   */
  async enqueue(job: DocumentMemoryJobRecord): Promise<DocumentMemoryJobRecord> {
    try {
      return await this.database.transaction(async (manager) => {
        const duplicate = (await manager.query(
          `SELECT ${JOB_COLUMNS} FROM document_memory_jobs
           WHERE dedupe_key=? LIMIT 1 FOR UPDATE`,
          [job.dedupe_key],
        )) as Record<string, unknown>[];
        if (duplicate[0]) return mapMemoryJob(duplicate[0]);

        await manager.query(
          `UPDATE document_memory_jobs SET status='superseded',dedupe_key=NULL,
           worker_id=NULL,lease_expires_at=NULL,finished_at=?,updated_at=?
           WHERE doc_id=? AND (document_version<? OR (document_version=? AND dedupe_key<>?))
             AND status IN ('queued','running','retry_wait')`,
          [
            job.updated_at,
            job.updated_at,
            job.doc_id,
            job.document_version,
            job.document_version,
            job.dedupe_key,
          ],
        );
        const generations = (await manager.query(
          `SELECT COALESCE(MAX(generation),0) AS generation FROM document_memory_jobs
           WHERE doc_id=? AND document_version=?`,
          [job.doc_id, job.document_version],
        )) as Array<{ generation: number | string }>;
        const next = {
          ...job,
          generation: Number(generations[0]?.generation ?? 0) + 1,
        };
        await manager.query(
          `INSERT INTO document_memory_jobs
            (job_id,doc_id,document_version,generation,status,attempts,max_attempts,
             requested_by,space_id,dedupe_key,next_run_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            next.job_id,
            next.doc_id,
            next.document_version,
            next.generation,
            next.status,
            next.attempts,
            next.max_attempts,
            next.requested_by,
            next.space_id,
            next.dedupe_key,
            next.next_run_at,
            next.created_at,
            next.updated_at,
          ],
        );
        return next;
      });
    } catch (error) {
      const duplicate = await this.findByDedupeKey(job.dedupe_key);
      if (duplicate) return duplicate;
      throw error;
    }
  }

  /**
   * 按幂等键查询已存在的任务，避免重复创建。
   *
   * @param dedupeKey dedupeKey 参数（string | null）。
   * @returns 文档记忆提取任务；未找到或不可用时可能为空。
   */
  private async findByDedupeKey(dedupeKey: string | null): Promise<DocumentMemoryJobRecord | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${JOB_COLUMNS} FROM document_memory_jobs WHERE dedupe_key=? LIMIT 1`,
      [dedupeKey],
    );
    return rows[0] ? mapMemoryJob(rows[0]) : null;
  }
}

/**
 * 将数据库行转换为文档记忆提取任务。
 *
 * @param row 数据库查询返回的一行数据。
 * @returns 文档记忆提取任务。
 */
export function mapMemoryJob(row: Record<string, unknown>): DocumentMemoryJobRecord {
  /**
   * 把数据库时间值转换为 Date 对象，并处理空值。
   *
   * @param value 待校验或转换的值。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  const date = (value: unknown) => value == null ? null : new Date(value as string | Date);
  return {
    job_id: String(row.job_id),
    doc_id: String(row.doc_id),
    document_version: Number(row.document_version),
    generation: Number(row.generation),
    status: row.status as DocumentMemoryJobRecord['status'],
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    requested_by: String(row.requested_by),
    space_id: String(row.space_id),
    dedupe_key: row.dedupe_key == null ? null : String(row.dedupe_key),
    worker_id: row.worker_id == null ? null : String(row.worker_id),
    lease_expires_at: date(row.lease_expires_at),
    next_run_at: date(row.next_run_at),
    error: row.error == null ? null : String(row.error),
    created_at: new Date(row.created_at as string | Date),
    started_at: date(row.started_at),
    finished_at: date(row.finished_at),
    updated_at: new Date(row.updated_at as string | Date),
  };
}
