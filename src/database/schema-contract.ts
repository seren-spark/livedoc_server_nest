import { CURRENT_SCHEMA_VERSION } from './migration-version.js';

export const REQUIRED_SCHEMA_COLUMNS = {
  schema_migrations: ['version', 'applied_at'],
  demo_users: ['user_id', 'username', 'email', 'password_hash', 'space_id', 'is_active'],
  demo_user_teams: ['user_id', 'team_id'],
  demo_sessions: ['token_hash', 'user_id', 'expires_at', 'created_at'],
  knowledge_documents: [
    'doc_id', 'space_id', 'title', 'content', 'visibility', 'source_type', 'tags',
    'team_id', 'owner_id', 'url', 'editor_content', 'source_import_id',
    'document_version', 'index_status', 'active_index_version',
    'latest_index_job_id', 'chunk_count', 'indexed_at', 'index_error',
    'created_at', 'updated_at',
  ],
  index_jobs: [
    'job_id', 'doc_id', 'document_version', 'generation', 'status', 'attempts',
    'max_attempts', 'requested_by', 'space_id', 'request_payload',
    'config_fingerprint', 'dedupe_key', 'worker_id', 'lease_expires_at',
    'next_run_at', 'error', 'created_at', 'started_at', 'finished_at', 'updated_at',
  ],
  document_imports: [
    'import_id', 'space_id', 'owner_id', 'visibility', 'team_id', 'tags', 'folder',
    'title', 'filename', 'mime_type', 'file_size', 'sha256', 'source_asset_id',
    'status', 'progress', 'stage', 'parsed_content', 'editor_content',
    'parser_version', 'error', 'document_id', 'latest_job_id', 'created_at', 'updated_at',
  ],
  document_assets: [
    'asset_id', 'space_id', 'owner_id', 'import_id', 'doc_id', 'kind', 'filename',
    'mime_type', 'byte_size', 'sha256', 'storage_key', 'page_number', 'ordinal',
    'width', 'height', 'ocr_text', 'description', 'analysis_status',
    'analysis_error', 'created_at',
  ],
  document_import_jobs: [
    'job_id', 'import_id', 'status', 'attempts', 'max_attempts', 'generation',
    'requested_by', 'space_id', 'config_fingerprint', 'worker_id',
    'lease_expires_at', 'next_run_at', 'error', 'created_at', 'started_at',
    'finished_at', 'updated_at',
  ],
  conversation_messages: [
    'message_id', 'conversation_id', 'user_id', 'space_id', 'role', 'content',
    'created_at', 'expires_at',
  ],
  conversation_turns: [
    'turn_id', 'conversation_id', 'user_id', 'space_id', 'doc_id',
    'user_content', 'assistant_content', 'created_at', 'expires_at',
  ],
  document_memory_profiles: [
    'doc_id', 'space_id', 'source_document_version', 'memory_version', 'status',
    'glossary', 'style_tags', 'global_settings', 'suppressed_keys',
    'source_chunk_hashes', 'last_error', 'created_at', 'updated_at',
  ],
  document_memory_jobs: [
    'job_id', 'doc_id', 'document_version', 'generation', 'status', 'attempts',
    'max_attempts', 'requested_by', 'space_id', 'force_full', 'dedupe_key',
    'worker_id', 'lease_expires_at', 'next_run_at', 'error', 'created_at',
    'started_at', 'finished_at', 'updated_at',
  ],
  rag_traces: [
    'trace_id', 'user_id', 'space_id', 'entrypoint', 'query_text', 'mode',
    'tool_name', 'status', 'has_evidence', 'retrieval_ms', 'generation_ms',
    'citation_count', 'inserted', 'helpful_state', 'model_name',
    'collection_name', 'payload', 'error', 'created_at', 'completed_at',
  ],
  rag_feedback_events: [
    'event_id', 'trace_id', 'user_id', 'space_id', 'action', 'comment', 'created_at',
  ],
} as const;

export const REQUIRED_SCHEMA_INDEXES = {
  knowledge_documents: ['PRIMARY', 'ix_documents_space', 'ix_documents_source_import'],
  index_jobs: ['PRIMARY', 'ix_jobs_claim', 'ix_jobs_document', 'ux_jobs_dedupe_key'],
  document_imports: ['PRIMARY', 'ix_imports_owner', 'ix_imports_status'],
  document_assets: ['PRIMARY', 'ux_assets_storage_key', 'ix_assets_import', 'ix_assets_document'],
  document_import_jobs: ['PRIMARY', 'ix_import_jobs_claim', 'ix_import_jobs_import'],
  conversation_turns: ['PRIMARY', 'ix_turns_scope', 'ix_turns_expiry', 'ix_turns_document'],
  document_memory_profiles: ['PRIMARY', 'ix_memory_profiles_scope'],
  document_memory_jobs: ['PRIMARY', 'ix_memory_jobs_claim', 'ix_memory_jobs_document', 'ux_memory_jobs_dedupe'],
  rag_traces: ['PRIMARY', 'ix_traces_scope', 'ix_traces_owner'],
  rag_feedback_events: ['PRIMARY', 'ix_feedback_trace', 'ix_feedback_scope'],
} as const;

export type SchemaContractProblem = {
  kind: 'version' | 'table' | 'column' | 'index';
  table?: string;
  name: string;
};

type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

export async function inspectSchemaContract(query: Query): Promise<SchemaContractProblem[]> {
  const problems: SchemaContractProblem[] = [];
  const versions = await query<{ version: string }>(
    'SELECT version FROM schema_migrations WHERE version=?',
    [CURRENT_SCHEMA_VERSION],
  ).catch(() => []);
  if (!versions.length) problems.push({ kind: 'version', name: CURRENT_SCHEMA_VERSION });

  const columns = await query<{ table_name: string; column_name: string }>(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`,
  );
  const columnsByTable = new Map<string, Set<string>>();
  for (const row of columns) {
    const table = String(row.table_name);
    const names = columnsByTable.get(table) ?? new Set<string>();
    names.add(String(row.column_name));
    columnsByTable.set(table, names);
  }
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    const actual = columnsByTable.get(table);
    if (!actual) {
      problems.push({ kind: 'table', table, name: table });
      continue;
    }
    for (const column of required) {
      if (!actual.has(column)) problems.push({ kind: 'column', table, name: column });
    }
  }

  const indexes = await query<{ table_name: string; index_name: string }>(
    `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()`,
  );
  const indexesByTable = new Map<string, Set<string>>();
  for (const row of indexes) {
    const table = String(row.table_name);
    const names = indexesByTable.get(table) ?? new Set<string>();
    names.add(String(row.index_name));
    indexesByTable.set(table, names);
  }
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA_INDEXES)) {
    const actual = indexesByTable.get(table) ?? new Set<string>();
    for (const index of required) {
      if (!actual.has(index)) problems.push({ kind: 'index', table, name: index });
    }
  }
  return problems;
}

export function formatSchemaProblems(problems: SchemaContractProblem[]): string {
  return problems
    .map((problem) => problem.kind === 'version'
      ? `migration:${problem.name}`
      : `${problem.kind}:${problem.table}.${problem.name}`)
    .join(', ');
}
