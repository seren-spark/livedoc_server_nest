import { DatabaseService } from '../database/database.service.js';
import type { DocumentIndexRequest } from '../documents/document.types.js';
import type { IndexJobRecord } from './index-job.types.js';

const JOB_COLUMNS = `job_id,doc_id,document_version,generation,status,attempts,max_attempts,
  requested_by,space_id,request_payload,config_fingerprint,dedupe_key,worker_id,
  lease_expires_at,next_run_at,error,created_at,started_at,finished_at,updated_at`;

export class IndexJobsRepository {
  constructor(private readonly database: DatabaseService) {}

  async enqueue(job: IndexJobRecord): Promise<IndexJobRecord> {
    try {
      return await this.database.transaction(async (manager) => {
        const duplicate = (await manager.query(
          `SELECT ${JOB_COLUMNS} FROM index_jobs WHERE dedupe_key=? LIMIT 1 FOR UPDATE`,
          [job.dedupe_key],
        )) as Record<string, unknown>[];
        if (duplicate[0]) return mapIndexJob(duplicate[0]);

        const generations = (await manager.query(
          `SELECT COALESCE(MAX(generation),0) AS generation FROM index_jobs
           WHERE doc_id=? AND document_version=?`,
          [job.doc_id, job.document_version],
        )) as Array<{ generation: number | string }>;
        const next = {
          ...job,
          generation: Number(generations[0]?.generation ?? 0) + 1,
        };
        await manager.query(
          `INSERT INTO index_jobs
            (job_id,doc_id,document_version,generation,status,attempts,max_attempts,
             requested_by,space_id,request_payload,config_fingerprint,dedupe_key,
             next_run_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            JSON.stringify(next.request_payload),
            next.config_fingerprint,
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

  async listByDocument(docId: string): Promise<IndexJobRecord[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${JOB_COLUMNS} FROM index_jobs WHERE doc_id=?`,
      [docId],
    );
    return rows.map(mapIndexJob);
  }

  private async findByDedupeKey(dedupeKey: string | null): Promise<IndexJobRecord | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${JOB_COLUMNS} FROM index_jobs WHERE dedupe_key=? LIMIT 1`,
      [dedupeKey],
    );
    return rows[0] ? mapIndexJob(rows[0]) : null;
  }
}

function parsePayload(value: unknown): DocumentIndexRequest {
  return typeof value === 'string'
    ? JSON.parse(value) as DocumentIndexRequest
    : value as DocumentIndexRequest;
}

export function mapIndexJob(row: Record<string, unknown>): IndexJobRecord {
  const date = (value: unknown) =>
    value == null ? null : new Date(value as string | number | Date);
  return {
    job_id: String(row.job_id),
    doc_id: String(row.doc_id),
    document_version: Number(row.document_version),
    generation: Number(row.generation),
    status: row.status as IndexJobRecord['status'],
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
