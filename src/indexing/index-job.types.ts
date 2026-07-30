import type { AccessContext, IndexJobStatus } from '../common/types.js';
import type { DocumentIndexRequest } from '../documents/document.types.js';

export interface IndexJobRecord {
  job_id: string;
  doc_id: string;
  document_version: number;
  generation: number;
  status: IndexJobStatus;
  attempts: number;
  max_attempts: number;
  requested_by: string;
  space_id: string;
  request_payload: DocumentIndexRequest;
  config_fingerprint: string;
  dedupe_key: string | null;
  worker_id: string | null;
  lease_expires_at: Date | null;
  next_run_at: Date | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

export function jobResponse(job: IndexJobRecord) {
  return {
    job_id: job.job_id,
    doc_id: job.doc_id,
    document_version: job.document_version,
    status: job.status,
    attempts: job.attempts,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    next_run_at: job.next_run_at,
    error: job.error,
  };
}

export function contextForJob(job: IndexJobRecord): AccessContext {
  return { user_id: job.requested_by, space_id: job.space_id, team_ids: [] };
}
