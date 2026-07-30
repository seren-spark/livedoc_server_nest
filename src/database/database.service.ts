import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private dataSource?: DataSource;

  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return (
      this.metadataEnabled ||
      this.memoryEnabled ||
      this.indexJobsEnabled ||
      this.observabilityEnabled
    );
  }

  get metadataEnabled(): boolean {
    return this.config.metadataStore === 'mysql';
  }

  get memoryEnabled(): boolean {
    return this.config.memoryStore === 'mysql';
  }

  get indexJobsEnabled(): boolean {
    return this.config.indexJobStore === 'mysql';
  }

  get observabilityEnabled(): boolean {
    return this.config.observabilityStore === 'mysql';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    if (!this.config.databaseUrl) {
      throw new Error('DATABASE_URL is required when a MySQL-backed store is enabled');
    }
    this.dataSource = new DataSource({
      type: 'mysql',
      url: this.config.databaseUrl,
      synchronize: false,
      migrationsRun: false,
      logging: false,
      supportBigNumbers: true,
      timezone: 'Z',
    });
    await this.dataSource.initialize();
    await this.migrate();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dataSource?.isInitialized) await this.dataSource.destroy();
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.dataSource) throw new Error('MySQL store is not enabled');
    return (await this.dataSource.query(sql, params)) as T[];
  }

  get source(): DataSource {
    if (!this.dataSource) throw new Error('MySQL store is not enabled');
    return this.dataSource;
  }

  private async migrate(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS demo_users (
        user_id VARCHAR(128) PRIMARY KEY, username VARCHAR(128) NOT NULL,
        email VARCHAR(320) NOT NULL UNIQUE, password_hash VARCHAR(512) NOT NULL,
        space_id VARCHAR(128) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        INDEX ix_demo_users_email (email), INDEX ix_demo_users_space (space_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS demo_user_teams (
        user_id VARCHAR(128) NOT NULL, team_id VARCHAR(128) NOT NULL,
        PRIMARY KEY (user_id, team_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS demo_sessions (
        token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(128) NOT NULL,
        expires_at DATETIME(6) NOT NULL, created_at DATETIME(6) NOT NULL,
        INDEX ix_demo_sessions_user (user_id), INDEX ix_demo_sessions_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS knowledge_documents (
        doc_id VARCHAR(128) PRIMARY KEY, space_id VARCHAR(128) NOT NULL,
        title VARCHAR(512) NOT NULL, content LONGTEXT NOT NULL,
        visibility VARCHAR(32) NOT NULL, source_type VARCHAR(64) NOT NULL,
        tags JSON NOT NULL, team_id VARCHAR(128) NULL, owner_id VARCHAR(128) NULL,
        url TEXT NULL, document_version INT NOT NULL DEFAULT 1,
        index_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        active_index_version INT NULL, latest_index_job_id VARCHAR(64) NULL,
        chunk_count INT NOT NULL DEFAULT 0, indexed_at DATETIME(6) NULL,
        index_error TEXT NULL, created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        INDEX ix_documents_space (space_id), INDEX ix_documents_visibility (visibility),
        INDEX ix_documents_owner (owner_id), INDEX ix_documents_team (team_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS index_jobs (
        job_id VARCHAR(64) PRIMARY KEY, doc_id VARCHAR(128) NOT NULL,
        document_version INT NOT NULL, generation INT NOT NULL,
        status VARCHAR(32) NOT NULL, attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        requested_by VARCHAR(128) NOT NULL, space_id VARCHAR(128) NOT NULL,
        request_payload JSON NOT NULL, config_fingerprint VARCHAR(128) NOT NULL,
        dedupe_key VARCHAR(320) NULL,
        worker_id VARCHAR(128) NULL, lease_expires_at DATETIME(6) NULL,
        next_run_at DATETIME(6) NULL, error TEXT NULL,
        created_at DATETIME(6) NOT NULL, started_at DATETIME(6) NULL,
        finished_at DATETIME(6) NULL, updated_at DATETIME(6) NOT NULL,
        INDEX ix_jobs_claim (status, next_run_at, lease_expires_at),
        INDEX ix_jobs_document (doc_id, document_version),
        UNIQUE INDEX ux_jobs_dedupe_key (dedupe_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS conversation_messages (
        message_id VARCHAR(32) PRIMARY KEY, conversation_id VARCHAR(128) NOT NULL,
        user_id VARCHAR(128) NOT NULL, space_id VARCHAR(128) NOT NULL,
        role VARCHAR(32) NOT NULL, content LONGTEXT NOT NULL,
        created_at DATETIME(6) NOT NULL, expires_at DATETIME(6) NOT NULL,
        INDEX ix_conversation_memory_scope (conversation_id, user_id, space_id, created_at),
        INDEX ix_conversation_memory_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS rag_traces (
        trace_id VARCHAR(64) PRIMARY KEY, user_id VARCHAR(128) NULL,
        space_id VARCHAR(128) NULL, entrypoint VARCHAR(64) NOT NULL,
        query_text LONGTEXT NOT NULL, mode VARCHAR(32) NOT NULL,
        tool_name VARCHAR(64) NULL, status VARCHAR(32) NOT NULL,
        has_evidence BOOLEAN NULL, retrieval_ms DOUBLE NOT NULL DEFAULT 0,
        generation_ms DOUBLE NOT NULL DEFAULT 0, citation_count INT NOT NULL DEFAULT 0,
        inserted BOOLEAN NOT NULL DEFAULT FALSE, helpful_state VARCHAR(32) NULL,
        model_name VARCHAR(256) NOT NULL DEFAULT '', collection_name VARCHAR(256) NOT NULL DEFAULT '',
        payload JSON NOT NULL, error TEXT NULL, created_at DATETIME(6) NOT NULL,
        completed_at DATETIME(6) NULL, INDEX ix_traces_scope (space_id, created_at),
        INDEX ix_traces_owner (user_id, trace_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS rag_feedback_events (
        event_id VARCHAR(64) PRIMARY KEY, trace_id VARCHAR(64) NOT NULL,
        user_id VARCHAR(128) NOT NULL, space_id VARCHAR(128) NOT NULL,
        action VARCHAR(32) NOT NULL, comment VARCHAR(500) NOT NULL,
        created_at DATETIME(6) NOT NULL, INDEX ix_feedback_trace (trace_id),
        INDEX ix_feedback_scope (space_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
    for (const statement of statements) await this.query(statement);
    await this.ensureColumn(
      'index_jobs',
      'max_attempts',
      'ALTER TABLE index_jobs ADD COLUMN max_attempts INT NOT NULL DEFAULT 3 AFTER attempts',
    );
    await this.ensureColumn(
      'index_jobs',
      'dedupe_key',
      'ALTER TABLE index_jobs ADD COLUMN dedupe_key VARCHAR(320) NULL AFTER config_fingerprint',
    );
    await this.ensureIndex(
      'index_jobs',
      'ux_jobs_dedupe_key',
      'CREATE UNIQUE INDEX ux_jobs_dedupe_key ON index_jobs (dedupe_key)',
    );
    await this.ensureColumn(
      'rag_traces',
      'inserted',
      'ALTER TABLE rag_traces ADD COLUMN inserted BOOLEAN NOT NULL DEFAULT FALSE AFTER citation_count',
    );
    await this.ensureColumn(
      'rag_traces',
      'helpful_state',
      'ALTER TABLE rag_traces ADD COLUMN helpful_state VARCHAR(32) NULL AFTER inserted',
    );
    await this.ensureColumn(
      'rag_traces',
      'model_name',
      "ALTER TABLE rag_traces ADD COLUMN model_name VARCHAR(256) NOT NULL DEFAULT '' AFTER helpful_state",
    );
    await this.ensureColumn(
      'rag_traces',
      'collection_name',
      "ALTER TABLE rag_traces ADD COLUMN collection_name VARCHAR(256) NOT NULL DEFAULT '' AFTER model_name",
    );
  }

  private async ensureColumn(table: string, column: string, alterSql: string): Promise<void> {
    const rows = await this.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (Number(rows[0]?.count ?? 0) === 0) await this.query(alterSql);
  }

  private async ensureIndex(table: string, index: string, createSql: string): Promise<void> {
    const rows = await this.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [table, index],
    );
    if (Number(rows[0]?.count ?? 0) === 0) await this.query(createSql);
  }
}
