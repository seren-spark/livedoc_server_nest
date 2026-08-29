import type { DatabaseService } from '../database/database.service.js';

export type PersistentJobStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'superseded'
  | 'canceled';

export interface PersistentJobRecord {
  job_id: string;
  status: PersistentJobStatus;
  attempts: number;
  max_attempts: number;
  generation: number;
  requested_by: string;
  space_id: string;
  worker_id: string | null;
  lease_expires_at: Date | null;
  next_run_at: Date | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
  dedupe_key?: string | null;
}

interface PersistentJobStoreOptions<TJob extends PersistentJobRecord> {
  database: DatabaseService;
  enabled: () => boolean;
  tableName: string;
  leaseSeconds: () => number;
  jobs: Map<string, TJob>;
  mapRow: (row: Record<string, unknown>) => TJob;
  hasDedupeKey?: boolean;
}

interface FinishOptions<TJob extends PersistentJobRecord> {
  error?: string | null;
  nextRunAt?: Date | null;
  workerId?: string | null;
  generation?: number;
  dedupeKey?: TJob['dedupe_key'];
}

const ACTIVE_STATUSES = ['queued', 'running', 'retry_wait'] as const;

export class PersistentJobStore<TJob extends PersistentJobRecord> {
  constructor(private readonly options: PersistentJobStoreOptions<TJob>) {}

  async get(jobId: string): Promise<TJob | null> {
    if (!this.options.enabled()) return this.options.jobs.get(jobId) ?? null;
    const rows = await this.options.database.query<Record<string, unknown>>(
      `SELECT * FROM ${this.options.tableName} WHERE job_id = ?`,
      [jobId],
    );
    return rows[0] ? this.options.mapRow(rows[0]) : null;
  }

  async claimNext(workerId: string): Promise<TJob | null> {
    const now = new Date();
    if (!this.options.enabled()) {
      const candidate = [...this.options.jobs.values()]
        .filter((job) => isClaimable(job, now))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0];
      if (!candidate) return null;
      const claimed = {
        ...candidate,
        status: 'running',
        attempts: candidate.attempts + 1,
        worker_id: workerId,
        lease_expires_at: new Date(now.getTime() + this.options.leaseSeconds() * 1000),
        started_at: candidate.started_at ?? now,
        updated_at: now,
      } as TJob;
      this.options.jobs.set(claimed.job_id, claimed);
      return claimed;
    }

    const runner = this.options.database.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const rows = (await runner.query(
        `SELECT * FROM ${this.options.tableName}
         WHERE
           (status IN ('queued','retry_wait') AND (next_run_at IS NULL OR next_run_at <= ?))
           OR (status='running' AND lease_expires_at <= ?)
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now, now],
      )) as Record<string, unknown>[];
      const row = rows[0];
      if (!row) {
        await runner.commitTransaction();
        return null;
      }
      const lease = new Date(now.getTime() + this.options.leaseSeconds() * 1000);
      await runner.query(
        `UPDATE ${this.options.tableName} SET status='running', attempts=attempts+1,
         worker_id=?, started_at=COALESCE(started_at, ?), lease_expires_at=?,
         updated_at=? WHERE job_id=?`,
        [workerId, now, lease, now, row.job_id],
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

  async heartbeat(
    jobId: string,
    workerId: string,
    generation: number,
  ): Promise<boolean> {
    const lease = new Date(Date.now() + this.options.leaseSeconds() * 1000);
    if (this.options.enabled()) {
      const result = await this.options.database.source.query(
        `UPDATE ${this.options.tableName} SET lease_expires_at=?, updated_at=UTC_TIMESTAMP(6)
         WHERE job_id=? AND worker_id=? AND generation=? AND status='running'`,
        [lease, jobId, workerId, generation],
      );
      return Number(result?.affectedRows ?? 0) === 1;
    }
    const job = this.options.jobs.get(jobId);
    if (
      !job ||
      job.worker_id !== workerId ||
      job.generation !== generation ||
      job.status !== 'running'
    ) {
      return false;
    }
    this.options.jobs.set(jobId, {
      ...job,
      lease_expires_at: lease,
      updated_at: new Date(),
    });
    return true;
  }

  async ownsLease(
    jobId: string,
    workerId: string | null,
    generation: number,
  ): Promise<boolean> {
    if (!workerId) return false;
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

  async isRunning(jobId: string, generation: number): Promise<boolean> {
    const job = await this.get(jobId);
    return Boolean(job && job.status === 'running' && job.generation === generation);
  }

  async finish(
    jobId: string,
    status: TJob['status'],
    options: FinishOptions<TJob> = {},
  ): Promise<TJob | null> {
    const current = await this.get(jobId);
    if (!current) return null;
    if (
      options.workerId &&
      (current.worker_id !== options.workerId ||
        current.generation !== options.generation)
    ) {
      return current;
    }

    const now = new Date();
    const nextRunAt =
      options.nextRunAt === undefined ? current.next_run_at : options.nextRunAt;
    const finishedAt = status === 'retry_wait' ? null : now;
    const dedupeKey =
      this.options.hasDedupeKey && status === 'retry_wait'
        ? options.dedupeKey === undefined
          ? current.dedupe_key ?? null
          : options.dedupeKey ?? null
        : null;
    const next = {
      ...current,
      status,
      error: options.error ? options.error.slice(0, 2000) : null,
      next_run_at: nextRunAt,
      dedupe_key: this.options.hasDedupeKey ? dedupeKey : current.dedupe_key,
      worker_id: null,
      lease_expires_at: null,
      finished_at: finishedAt,
      updated_at: now,
    } as TJob;

    if (!this.options.enabled()) {
      this.options.jobs.set(jobId, next);
      return next;
    }

    const setParts = [
      'status=?',
      'error=?',
      'next_run_at=?',
      'worker_id=NULL',
      'lease_expires_at=NULL',
      'finished_at=?',
      'updated_at=?',
    ];
    const params: unknown[] = [
      next.status,
      next.error,
      next.next_run_at,
      next.finished_at,
      next.updated_at,
    ];
    if (this.options.hasDedupeKey) {
      setParts.splice(3, 0, 'dedupe_key=?');
      params.splice(3, 0, next.dedupe_key ?? null);
    }

    const guarded = Boolean(options.workerId);
    const where = guarded
      ? "job_id=? AND worker_id=? AND generation=? AND status='running'"
      : 'job_id=?';
    params.push(jobId);
    if (guarded) params.push(options.workerId, options.generation);

    const result = await this.options.database.source.query(
      `UPDATE ${this.options.tableName} SET ${setParts.join(', ')} WHERE ${where}`,
      params,
    );
    if (guarded && Number(result?.affectedRows ?? 0) !== 1) {
      return this.get(jobId);
    }
    return next;
  }

  async cancelWhere(input: {
    whereSql: string;
    params: unknown[];
    predicate: (job: TJob) => boolean;
    error?: string | null;
  }): Promise<void> {
    const now = new Date();
    if (this.options.enabled()) {
      const dedupeSet = this.options.hasDedupeKey ? 'dedupe_key=NULL,' : '';
      await this.options.database.query(
        `UPDATE ${this.options.tableName} SET status='canceled', error=?, ${dedupeSet}
         worker_id=NULL, lease_expires_at=NULL, finished_at=UTC_TIMESTAMP(6),
         updated_at=UTC_TIMESTAMP(6)
         WHERE ${input.whereSql} AND status IN ('queued','running','retry_wait')`,
        [input.error ?? null, ...input.params],
      );
      return;
    }
    for (const [id, job] of this.options.jobs) {
      if (!input.predicate(job) || !ACTIVE_STATUSES.includes(job.status as never)) continue;
      this.options.jobs.set(id, {
        ...job,
        status: 'canceled',
        error: input.error ?? null,
        dedupe_key: this.options.hasDedupeKey ? null : job.dedupe_key,
        worker_id: null,
        lease_expires_at: null,
        finished_at: now,
        updated_at: now,
      } as TJob);
    }
  }

  async deleteWhere(input: {
    whereSql: string;
    params: unknown[];
    predicate: (job: TJob) => boolean;
  }): Promise<void> {
    if (this.options.enabled()) {
      await this.options.database.query(
        `DELETE FROM ${this.options.tableName} WHERE ${input.whereSql}`,
        input.params,
      );
      return;
    }
    for (const [id, job] of this.options.jobs) {
      if (input.predicate(job)) this.options.jobs.delete(id);
    }
  }

  async activeCountBySpace(spaceId: string): Promise<number> {
    if (!this.options.enabled()) {
      return [...this.options.jobs.values()].filter(
        (job) => job.space_id === spaceId && ACTIVE_STATUSES.includes(job.status as never),
      ).length;
    }
    const rows = await this.options.database.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${this.options.tableName}
       WHERE space_id=? AND status IN ('queued','running','retry_wait')`,
      [spaceId],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

function isClaimable(job: PersistentJobRecord, now: Date): boolean {
  return (
    ((job.status === 'queued' || job.status === 'retry_wait') &&
      (!job.next_run_at || job.next_run_at <= now)) ||
    (job.status === 'running' &&
      Boolean(job.lease_expires_at && job.lease_expires_at <= now))
  );
}
