import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/app-config.js';
import { CURRENT_SCHEMA_VERSION } from './migration-version.js';
import { formatSchemaProblems, inspectSchemaContract } from './schema-contract.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private dataSource?: DataSource;

  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return (
      this.metadataEnabled ||
      this.memoryEnabled ||
      this.indexJobsEnabled ||
      this.importJobsEnabled ||
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

  get importJobsEnabled(): boolean {
    return this.config.importJobStore === 'mysql';
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
    if (process.env.LIVEDOC_RUN_MIGRATIONS === 'true') {
      await this.migrate();
    } else {
      await this.assertSchemaContract();
    }
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

  async migrate(): Promise<void> {
    await this.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) PRIMARY KEY, applied_at DATETIME(6) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const applied = await this.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version=?',
      [CURRENT_SCHEMA_VERSION],
    );
    const alreadyApplied = applied.length > 0;
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
      `CREATE TABLE IF NOT EXISTS document_imports (
        import_id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(128) NOT NULL,
        owner_id VARCHAR(128) NOT NULL, visibility VARCHAR(32) NOT NULL,
        team_id VARCHAR(128) NULL, tags JSON NOT NULL, folder VARCHAR(256) NULL,
        title VARCHAR(512) NOT NULL, filename VARCHAR(512) NOT NULL,
        mime_type VARCHAR(128) NOT NULL, file_size BIGINT NOT NULL,
        sha256 VARCHAR(64) NOT NULL, source_asset_id VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL, progress INT NOT NULL DEFAULT 0,
        stage VARCHAR(128) NOT NULL, parsed_content LONGTEXT NOT NULL,
        editor_content JSON NULL, parser_version VARCHAR(128) NULL,
        error TEXT NULL, document_id VARCHAR(128) NULL, latest_job_id VARCHAR(64) NULL,
        created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        INDEX ix_imports_owner (space_id, owner_id),
        INDEX ix_imports_status (status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS document_assets (
        asset_id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(128) NOT NULL,
        owner_id VARCHAR(128) NOT NULL, import_id VARCHAR(64) NULL,
        doc_id VARCHAR(128) NULL, kind VARCHAR(32) NOT NULL,
        filename VARCHAR(512) NOT NULL, mime_type VARCHAR(128) NOT NULL,
        byte_size BIGINT NOT NULL, sha256 VARCHAR(64) NOT NULL,
        storage_key VARCHAR(768) NOT NULL, page_number INT NULL, ordinal INT NULL,
        width INT NULL, height INT NULL, ocr_text LONGTEXT NOT NULL,
        description LONGTEXT NOT NULL, analysis_status VARCHAR(32) NOT NULL,
        analysis_error TEXT NULL, created_at DATETIME(6) NOT NULL,
        UNIQUE INDEX ux_assets_storage_key (storage_key),
        INDEX ix_assets_import (import_id), INDEX ix_assets_document (doc_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS document_import_jobs (
        job_id VARCHAR(64) PRIMARY KEY, import_id VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL, attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3, generation INT NOT NULL DEFAULT 1,
        requested_by VARCHAR(128) NOT NULL, space_id VARCHAR(128) NOT NULL,
        config_fingerprint VARCHAR(128) NOT NULL,
        worker_id VARCHAR(128) NULL, lease_expires_at DATETIME(6) NULL,
        next_run_at DATETIME(6) NOT NULL, error TEXT NULL,
        created_at DATETIME(6) NOT NULL, started_at DATETIME(6) NULL,
        finished_at DATETIME(6) NULL, updated_at DATETIME(6) NOT NULL,
        INDEX ix_import_jobs_claim (status, next_run_at, lease_expires_at),
        INDEX ix_import_jobs_import (import_id, generation)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS conversation_messages (
        message_id VARCHAR(32) PRIMARY KEY, conversation_id VARCHAR(128) NOT NULL,
        user_id VARCHAR(128) NOT NULL, space_id VARCHAR(128) NOT NULL,
        role VARCHAR(32) NOT NULL, content LONGTEXT NOT NULL,
        created_at DATETIME(6) NOT NULL, expires_at DATETIME(6) NOT NULL,
        INDEX ix_conversation_memory_scope (conversation_id, user_id, space_id, created_at),
        INDEX ix_conversation_memory_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS conversation_turns (
        turn_id VARCHAR(32) PRIMARY KEY, conversation_id VARCHAR(128) NOT NULL,
        user_id VARCHAR(128) NOT NULL, space_id VARCHAR(128) NOT NULL,
        doc_id VARCHAR(128) NULL, user_content LONGTEXT NOT NULL,
        assistant_content LONGTEXT NOT NULL, created_at DATETIME(6) NOT NULL,
        expires_at DATETIME(6) NOT NULL,
        INDEX ix_turns_scope (conversation_id, user_id, space_id, doc_id, created_at),
        INDEX ix_turns_expiry (expires_at), INDEX ix_turns_document (doc_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS document_memory_profiles (
        doc_id VARCHAR(128) PRIMARY KEY, space_id VARCHAR(128) NOT NULL,
        source_document_version INT NOT NULL DEFAULT 0,
        memory_version INT NOT NULL DEFAULT 0, status VARCHAR(32) NOT NULL,
        glossary JSON NOT NULL, style_tags JSON NOT NULL,
        global_settings JSON NOT NULL, suppressed_keys JSON NOT NULL,
        source_chunk_hashes JSON NOT NULL, last_error TEXT NULL,
        created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        INDEX ix_memory_profiles_scope (space_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS document_memory_jobs (
        job_id VARCHAR(32) PRIMARY KEY, doc_id VARCHAR(128) NOT NULL,
        document_version INT NOT NULL, generation INT NOT NULL,
        status VARCHAR(32) NOT NULL, attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3, requested_by VARCHAR(128) NOT NULL,
        space_id VARCHAR(128) NOT NULL, force_full BOOLEAN NOT NULL DEFAULT FALSE,
        dedupe_key VARCHAR(320) NULL, worker_id VARCHAR(128) NULL,
        lease_expires_at DATETIME(6) NULL, next_run_at DATETIME(6) NULL,
        error TEXT NULL, created_at DATETIME(6) NOT NULL,
        started_at DATETIME(6) NULL, finished_at DATETIME(6) NULL,
        updated_at DATETIME(6) NOT NULL,
        INDEX ix_memory_jobs_claim (status, next_run_at, lease_expires_at),
        INDEX ix_memory_jobs_document (doc_id, document_version),
        UNIQUE INDEX ux_memory_jobs_dedupe (dedupe_key)
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
      'knowledge_documents',
      'editor_content',
      'ALTER TABLE knowledge_documents ADD COLUMN editor_content JSON NULL AFTER url',
    );
    await this.ensureColumn(
      'knowledge_documents',
      'source_import_id',
      'ALTER TABLE knowledge_documents ADD COLUMN source_import_id VARCHAR(64) NULL AFTER editor_content',
    );
    await this.ensureIndex(
      'knowledge_documents',
      'ix_documents_source_import',
      'CREATE INDEX ix_documents_source_import ON knowledge_documents (source_import_id)',
    );
    await this.ensureIndex(
      'knowledge_documents',
      'ix_documents_space',
      'CREATE INDEX ix_documents_space ON knowledge_documents (space_id)',
    );
    await this.ensureColumn(
      'document_import_jobs',
      'config_fingerprint',
      "ALTER TABLE document_import_jobs ADD COLUMN config_fingerprint VARCHAR(128) NOT NULL DEFAULT '' AFTER space_id",
    );
    await this.ensureColumn(
      'index_jobs',
      'max_attempts',
      'ALTER TABLE index_jobs ADD COLUMN max_attempts INT NOT NULL DEFAULT 3 AFTER attempts',
    );
    await this.ensureColumn(
      'index_jobs',
      'request_payload',
      'ALTER TABLE index_jobs ADD COLUMN request_payload JSON NULL AFTER space_id',
    );
    await this.query(
      `UPDATE index_jobs SET request_payload=payload
       WHERE request_payload IS NULL AND payload IS NOT NULL`,
    ).catch((error: unknown) => {
      if (!isUnknownColumn(error, 'payload')) throw error;
    });
    const emptyPayloads = await this.query<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM index_jobs WHERE request_payload IS NULL',
    );
    if (Number(emptyPayloads[0]?.count ?? 0) > 0) {
      throw new Error('Cannot migrate index_jobs.request_payload: legacy rows contain no request payload');
    }
    await this.query('ALTER TABLE index_jobs MODIFY COLUMN request_payload JSON NOT NULL');
    await this.relaxLegacyColumn(
      'index_jobs',
      'payload',
      'ALTER TABLE index_jobs MODIFY COLUMN payload JSON NULL',
    );
    await this.ensureColumn(
      'index_jobs',
      'lease_expires_at',
      'ALTER TABLE index_jobs ADD COLUMN lease_expires_at DATETIME(6) NULL AFTER worker_id',
    );
    await this.query(
      `UPDATE index_jobs SET lease_expires_at=lease_until
       WHERE lease_expires_at IS NULL AND lease_until IS NOT NULL`,
    ).catch((error: unknown) => {
      if (!isUnknownColumn(error, 'lease_until')) throw error;
    });
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
    await this.ensureIndex(
      'index_jobs',
      'ix_jobs_claim',
      'CREATE INDEX ix_jobs_claim ON index_jobs (status, next_run_at, lease_expires_at)',
    );
    await this.ensureIndex(
      'index_jobs',
      'ix_jobs_document',
      'CREATE INDEX ix_jobs_document ON index_jobs (doc_id, document_version)',
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
    await this.ensureColumn(
      'rag_traces',
      'payload',
      'ALTER TABLE rag_traces ADD COLUMN payload JSON NULL AFTER collection_name',
    );
    await this.query(
      `UPDATE rag_traces SET payload=JSON_OBJECT(
         'trace', COALESCE(trace_json, JSON_OBJECT()),
         'citations', COALESCE(citations_json, JSON_ARRAY())
       ) WHERE payload IS NULL`,
    ).catch(async (error: unknown) => {
      if (!isUnknownColumn(error, 'trace_json') && !isUnknownColumn(error, 'citations_json')) throw error;
      await this.query(
        `UPDATE rag_traces SET payload=JSON_OBJECT('trace', JSON_OBJECT(), 'citations', JSON_ARRAY())
         WHERE payload IS NULL`,
      );
    });
    await this.query('ALTER TABLE rag_traces MODIFY COLUMN payload JSON NOT NULL');
    await this.relaxLegacyColumn(
      'rag_traces',
      'trace_json',
      'ALTER TABLE rag_traces MODIFY COLUMN trace_json JSON NULL',
    );
    await this.relaxLegacyColumn(
      'rag_traces',
      'citations_json',
      'ALTER TABLE rag_traces MODIFY COLUMN citations_json JSON NULL',
    );
    await this.ensureIndex(
      'rag_traces',
      'ix_traces_scope',
      'CREATE INDEX ix_traces_scope ON rag_traces (space_id, created_at)',
    );
    await this.ensureIndex(
      'rag_traces',
      'ix_traces_owner',
      'CREATE INDEX ix_traces_owner ON rag_traces (user_id, trace_id)',
    );
    await this.ensureIndex(
      'rag_feedback_events',
      'ix_feedback_trace',
      'CREATE INDEX ix_feedback_trace ON rag_feedback_events (trace_id)',
    );
    await this.ensureIndex(
      'rag_feedback_events',
      'ix_feedback_scope',
      'CREATE INDEX ix_feedback_scope ON rag_feedback_events (space_id, created_at)',
    );
    if (!alreadyApplied) {
      await this.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        [CURRENT_SCHEMA_VERSION, new Date()],
      );
    }
    await this.assertSchemaContract();
  }

  async assertSchemaContract(): Promise<void> {
    const problems = await inspectSchemaContract((sql, params = []) => this.query(sql, params));
    if (problems.length) {
      throw new Error(
        `MySQL schema contract is not satisfied: ${formatSchemaProblems(problems)}. ` +
        'Run npm run db:migrate before starting the API or workers.',
      );
    }
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

  private async relaxLegacyColumn(table: string, column: string, alterSql: string): Promise<void> {
    const rows = await this.query<{ is_nullable: string }>(
      `SELECT IS_NULLABLE AS is_nullable FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (rows[0] && String(rows[0].is_nullable).toUpperCase() === 'NO') {
      await this.query(alterSql);
    }
  }
}

function isUnknownColumn(error: unknown, column: string): boolean {
  const value = error as { code?: string; message?: string };
  return value?.code === 'ER_BAD_FIELD_ERROR' && String(value.message ?? '').includes(column);
}
