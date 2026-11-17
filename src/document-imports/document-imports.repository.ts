/**
 * @file 导入任务存储。持久化导入草稿与任务，使用事务完成确认、资源绑定和索引入队。
 */
import type { EntityManager } from 'typeorm';
import type { Visibility } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import type { DocumentAssetRecord } from '../documents/assets/asset.types.js';
import { mapAssetRow } from '../documents/assets/assets.repository.js';
import type { DocumentRecord } from '../documents/document.types.js';
import { mapDocumentRow } from '../documents/documents.repository.js';
import type { IndexJobRecord } from '../indexing/index-job.types.js';
import type { DocumentImportRecord, ImportJobRecord } from './document-import.types.js';

const IMPORT_COLUMNS = `import_id,space_id,owner_id,visibility,team_id,tags,folder,title,
  filename,mime_type,file_size,sha256,source_asset_id,status,progress,stage,parsed_content,
  editor_content,parser_version,error,document_id,latest_job_id,created_at,updated_at`;

const ASSET_COLUMNS = `asset_id,space_id,owner_id,import_id,doc_id,kind,filename,mime_type,
  byte_size,sha256,storage_key,page_number,ordinal,width,height,ocr_text,description,
  analysis_status,analysis_error,created_at`;

const DOCUMENT_COLUMNS = `doc_id,space_id,title,content,visibility,source_type,tags,team_id,
  owner_id,url,editor_content,source_import_id,document_version,index_status,
  active_index_version,latest_index_job_id,chunk_count,indexed_at,index_error,created_at,updated_at`;

const PATCH_COLUMNS = new Set<keyof DocumentImportRecord>([
  'visibility',
  'team_id',
  'tags',
  'folder',
  'title',
  'status',
  'progress',
  'stage',
  'parsed_content',
  'editor_content',
  'parser_version',
  'error',
  'document_id',
  'latest_job_id',
]);

export class DocumentImportsRepository {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 根据输入创建文档导入记录并返回结果。
   *
   * @param record 当前导入草稿记录。
   * @param job 当前导入解析任务。
   */
  async create(record: DocumentImportRecord, job: ImportJobRecord): Promise<void> {
    await this.database.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO document_imports (${IMPORT_COLUMNS}) VALUES (${placeholders(24)})`,
        importValues(record),
      );
      await this.insertJobWith(manager, job);
    });
  }

  /**
   * 按唯一标识读取存储记录。
   *
   * @param importId 文档导入记录标识。
   * @returns 文档导入记录；未找到或不可用时可能为空。
   */
  async findById(importId: string): Promise<DocumentImportRecord | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${IMPORT_COLUMNS} FROM document_imports WHERE import_id=?`,
      [importId],
    );
    return rows[0] ? mapImportRow(rows[0]) : null;
  }

  /**
   * 仅更新本次请求提供的文档导入记录字段。
   *
   * @param importId 文档导入记录标识。
   * @param values 当前导入草稿记录。
   * @param updatedAt updatedAt 参数（Date）。
   */
  async patch(
    importId: string,
    values: Partial<DocumentImportRecord>,
    updatedAt: Date,
  ): Promise<void> {
    const entries = Object.entries(values).filter(
      ([key]) => key !== 'assets' && PATCH_COLUMNS.has(key as keyof DocumentImportRecord),
    );
    if (!entries.length) return;
    await this.database.query(
      `UPDATE document_imports SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE import_id=?`,
      [
        ...entries.map(([key, value]) => serializeImportValue(key, value)),
        updatedAt,
        importId,
      ],
    );
  }

  /**
   * 插入一条后台任务记录。
   *
   * @param job 当前导入解析任务。
   */
  async insertJob(job: ImportJobRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO document_import_jobs
        (job_id,import_id,status,attempts,max_attempts,generation,requested_by,space_id,
         config_fingerprint,worker_id,lease_expires_at,next_run_at,error,created_at,
         started_at,finished_at,updated_at)
       VALUES (${placeholders(17)})`,
      jobValues(job),
    );
  }

  /**
   * 删除指定文档导入记录。
   *
   * @param importId 文档导入记录标识。
   */
  async delete(importId: string): Promise<void> {
    await this.database.query('DELETE FROM document_imports WHERE import_id=?', [importId]);
  }

  /**
   * 查询超过保留期限、可清理的记录标识。
   *
   * @param cutoff 判断记录是否过期的时间分界。
   * @returns 整理后的字符串列表。
   */
  async listExpiredIds(cutoff: Date): Promise<string[]> {
    const rows = await this.database.query<{ import_id: string }>(
      "SELECT import_id FROM document_imports WHERE status<>'confirmed' AND updated_at<?",
      [cutoff],
    );
    return rows.map((row) => row.import_id);
  }

  /**
   * 根据已有任务记录计算下一次执行代次。
   *
   * @param importId 文档导入记录标识。
   * @returns 计算得到的数值。
   */
  async nextGeneration(importId: string): Promise<number> {
    const rows = await this.database.query<{ generation: number | string }>(
      `SELECT COALESCE(MAX(generation),0) AS generation FROM document_import_jobs
       WHERE import_id=?`,
      [importId],
    );
    return Number(rows[0]?.generation ?? 0) + 1;
  }

  /**
   * 在事务内锁定导入记录，防止确认与修改并发。
   *
   * @param manager 当前数据库事务执行器。
   * @param importId 文档导入记录标识。
   * @returns 文档导入记录；未找到或不可用时可能为空。
   */
  async lockImport(manager: EntityManager, importId: string): Promise<DocumentImportRecord | null> {
    const rows = await manager.query(
      `SELECT ${IMPORT_COLUMNS} FROM document_imports WHERE import_id=? FOR UPDATE`,
      [importId],
    ) as Record<string, unknown>[];
    return rows[0] ? mapImportRow(rows[0]) : null;
  }

  /**
   * 查找文档当前关联的最新索引任务。
   *
   * @param manager 当前数据库事务执行器。
   * @param docId 知识文档标识。
   * @returns 整理后的文本或标识；未找到或不可用时可能为空。
   */
  async latestDocumentJobId(manager: EntityManager, docId: string): Promise<string | null> {
    const rows = await manager.query(
      'SELECT latest_index_job_id FROM knowledge_documents WHERE doc_id=?',
      [docId],
    ) as Array<{ latest_index_job_id: string | null }>;
    return rows[0]?.latest_index_job_id ?? null;
  }

  /**
   * 在事务内锁定本次确认涉及的图片资源记录。
   *
   * @param manager 当前数据库事务执行器。
   * @param importId 文档导入记录标识。
   * @returns 整理后的结果列表。
   */
  async lockAssets(manager: EntityManager, importId: string): Promise<DocumentAssetRecord[]> {
    const rows = await manager.query(
      `SELECT ${ASSET_COLUMNS} FROM document_assets WHERE import_id=?
       ORDER BY COALESCE(ordinal,0),created_at FOR UPDATE`,
      [importId],
    ) as Record<string, unknown>[];
    return rows.map(mapAssetRow);
  }

  /**
   * 在事务内锁定目标文档，确保版本更新一致。
   *
   * @param manager 当前数据库事务执行器。
   * @param docId 知识文档标识。
   * @returns 知识文档记录；未找到或不可用时可能为空。
   */
  async lockDocument(manager: EntityManager, docId: string): Promise<DocumentRecord | null> {
    const rows = await manager.query(
      `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE doc_id=? FOR UPDATE`,
      [docId],
    ) as Record<string, unknown>[];
    return rows[0] ? mapDocumentRow(rows[0]) : null;
  }

  /**
   * 写入确认导入后生成的正式文档。
   *
   * @param manager 当前数据库事务执行器。
   * @param document 当前知识文档记录。
   */
  async insertDocument(manager: EntityManager, document: DocumentRecord): Promise<void> {
    await manager.query(
      `INSERT INTO knowledge_documents
        (doc_id,space_id,title,content,visibility,source_type,tags,team_id,owner_id,url,
         editor_content,source_import_id,document_version,index_status,chunk_count,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)`,
      [
        document.doc_id,
        document.space_id,
        document.title,
        document.content,
        document.visibility,
        document.source_type,
        JSON.stringify(document.tags),
        document.team_id,
        document.owner_id,
        document.url,
        document.editor_content == null ? null : JSON.stringify(document.editor_content),
        document.source_import_id,
        document.document_version,
        document.created_at,
        document.updated_at,
      ],
    );
  }

  /**
   * 查询与当前文档版本对应的索引任务。
   *
   * @param manager 当前数据库事务执行器。
   * @param latestJobId latestJob 对应的唯一标识。
   * @param dedupeKey dedupeKey 参数（string）。
   * @returns 整理后的文本或标识；未找到或不可用时可能为空。
   */
  async findIndexJobId(
    manager: EntityManager,
    latestJobId: string | null,
    dedupeKey: string,
  ): Promise<string | null> {
    if (latestJobId) {
      const rows = await manager.query('SELECT job_id FROM index_jobs WHERE job_id=?', [latestJobId]) as Array<{ job_id: string }>;
      if (rows[0]) return String(rows[0].job_id);
    }
    const rows = await manager.query(
      'SELECT job_id FROM index_jobs WHERE dedupe_key=? LIMIT 1 FOR UPDATE',
      [dedupeKey],
    ) as Array<{ job_id: string }>;
    return rows[0] ? String(rows[0].job_id) : null;
  }

  /**
   * 计算下一条索引任务的执行代次。
   *
   * @param manager 当前数据库事务执行器。
   * @param docId 知识文档标识。
   * @param documentVersion documentVersion 参数（number）。
   * @returns 计算得到的数值。
   */
  async nextIndexGeneration(
    manager: EntityManager,
    docId: string,
    documentVersion: number,
  ): Promise<number> {
    const rows = await manager.query(
      `SELECT COALESCE(MAX(generation),0) AS generation FROM index_jobs
       WHERE doc_id=? AND document_version=?`,
      [docId, documentVersion],
    ) as Array<{ generation: number | string }>;
    return Number(rows[0]?.generation ?? 0) + 1;
  }

  /**
   * 在当前事务中写入文档索引任务。
   *
   * @param manager 当前数据库事务执行器。
   * @param job 当前索引任务及其执行版本。
   */
  async insertIndexJob(manager: EntityManager, job: IndexJobRecord): Promise<void> {
    await manager.query(
      `INSERT INTO index_jobs
        (job_id,doc_id,document_version,generation,status,attempts,max_attempts,
         requested_by,space_id,request_payload,config_fingerprint,dedupe_key,
         next_run_at,created_at,updated_at)
       VALUES (${placeholders(15)})`,
      [
        job.job_id,
        job.doc_id,
        job.document_version,
        job.generation,
        job.status,
        job.attempts,
        job.max_attempts,
        job.requested_by,
        job.space_id,
        JSON.stringify(job.request_payload),
        job.config_fingerprint,
        job.dedupe_key,
        job.next_run_at,
        job.created_at,
        job.updated_at,
      ],
    );
  }

  /**
   * 在同一事务中锁定导入、文档和资源，提交正式文档及索引任务。
   *
   * @param manager 当前数据库事务执行器。
   * @param importId 文档导入记录标识。
   * @param docId 知识文档标识。
   * @param jobId 后台任务标识。
   * @param assets 当前文档关联的资源集合。
   * @param now 本次操作采用的时间基准。
   */
  async confirm(
    manager: EntityManager,
    importId: string,
    docId: string,
    jobId: string,
    assets: DocumentAssetRecord[],
    now: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE knowledge_documents SET index_status='queued',latest_index_job_id=?,
       index_error=NULL,updated_at=? WHERE doc_id=?`,
      [jobId, now, docId],
    );
    if (assets.length) {
      await manager.query(
        `UPDATE document_assets SET doc_id=? WHERE asset_id IN (${placeholders(assets.length)})`,
        [docId, ...assets.map((asset) => asset.asset_id)],
      );
    }
    await manager.query(
      `UPDATE document_imports SET status='confirmed',stage=?,document_id=?,progress=100,
       error=NULL,updated_at=? WHERE import_id=?`,
      ['已保存到知识库', docId, now, importId],
    );
  }

  /**
   * 使用传入的事务执行器写入导入任务。
   *
   * @param manager 当前数据库事务执行器。
   * @param job 当前导入解析任务。
   */
  private async insertJobWith(manager: EntityManager, job: ImportJobRecord): Promise<void> {
    await manager.query(
      `INSERT INTO document_import_jobs
        (job_id,import_id,status,attempts,max_attempts,generation,requested_by,space_id,
         config_fingerprint,worker_id,lease_expires_at,next_run_at,error,created_at,
         started_at,finished_at,updated_at)
       VALUES (${placeholders(17)})`,
      jobValues(job),
    );
  }
}

/**
 * 生成与参数数量匹配的 SQL 占位符。
 *
 * @param count 需要读取或处理的数量。
 * @returns 整理后的文本或标识。
 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/**
 * 将导入字段转换为数据库可保存的值。
 *
 * @param key 查询或存储使用的键。
 * @param value 待校验或转换的值。
 * @returns 本次操作整理后的结果。
 */
function serializeImportValue(key: string, value: unknown): unknown {
  if ((key === 'editor_content' || key === 'tags') && value != null) return JSON.stringify(value);
  return value;
}

/**
 * 按 SQL 列顺序整理导入记录参数。
 *
 * @param record 当前导入草稿记录。
 * @returns 整理后的结果列表。
 */
function importValues(record: DocumentImportRecord): unknown[] {
  return [
    record.import_id,
    record.space_id,
    record.owner_id,
    record.visibility,
    record.team_id,
    JSON.stringify(record.tags),
    record.folder,
    record.title,
    record.filename,
    record.mime_type,
    record.file_size,
    record.sha256,
    record.source_asset_id,
    record.status,
    record.progress,
    record.stage,
    record.parsed_content,
    record.editor_content == null ? null : JSON.stringify(record.editor_content),
    record.parser_version,
    record.error,
    record.document_id,
    record.latest_job_id,
    record.created_at,
    record.updated_at,
  ];
}

/**
 * 按 SQL 列顺序整理任务记录参数。
 *
 * @param job 当前导入解析任务。
 * @returns 整理后的结果列表。
 */
function jobValues(job: ImportJobRecord): unknown[] {
  return [
    job.job_id,
    job.import_id,
    job.status,
    job.attempts,
    job.max_attempts,
    job.generation,
    job.requested_by,
    job.space_id,
    job.config_fingerprint,
    job.worker_id,
    job.lease_expires_at,
    job.next_run_at,
    job.error,
    job.created_at,
    job.started_at,
    job.finished_at,
    job.updated_at,
  ];
}

/**
 * 把 JSON 字段解析为对象，兼容数据库已解码的值。
 *
 * @param value 待校验或转换的值。
 * @returns Record<string, unknown> 类型的处理结果；未找到或不可用时可能为空。
 */
function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 解析标签字段，转换为业务使用的字符串数组。
 *
 * @param value 待校验或转换的值。
 * @returns 整理后的字符串列表。
 */
function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 把数据库行还原为导入草稿记录。
 *
 * @param row 数据库查询返回的一行数据。
 * @returns 文档导入记录。
 */
export function mapImportRow(row: Record<string, unknown>): DocumentImportRecord {
  return {
    import_id: String(row.import_id),
    space_id: String(row.space_id),
    owner_id: String(row.owner_id),
    visibility: row.visibility as Visibility,
    team_id: row.team_id == null ? null : String(row.team_id),
    tags: parseTags(row.tags),
    folder: row.folder == null ? null : String(row.folder),
    title: String(row.title),
    filename: String(row.filename),
    mime_type: String(row.mime_type),
    file_size: Number(row.file_size),
    sha256: String(row.sha256),
    source_asset_id: String(row.source_asset_id),
    status: row.status as DocumentImportRecord['status'],
    progress: Number(row.progress),
    stage: String(row.stage),
    parsed_content: String(row.parsed_content ?? ''),
    editor_content: parseJsonObject(row.editor_content),
    parser_version: row.parser_version == null ? null : String(row.parser_version),
    error: row.error == null ? null : String(row.error),
    document_id: row.document_id == null ? null : String(row.document_id),
    latest_job_id: row.latest_job_id == null ? null : String(row.latest_job_id),
    created_at: new Date(row.created_at as string | Date),
    updated_at: new Date(row.updated_at as string | Date),
  };
}

/**
 * 把数据库行还原为导入解析任务。
 *
 * @param row 数据库查询返回的一行数据。
 * @returns ImportJobRecord 类型的处理结果。
 */
export function mapImportJobRow(row: Record<string, unknown>): ImportJobRecord {
  /**
   * 把数据库时间值转换为 Date 对象，并处理空值。
   *
   * @param value 待校验或转换的值。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  const date = (value: unknown) => value == null ? null : new Date(value as string | Date);
  return {
    job_id: String(row.job_id),
    import_id: String(row.import_id),
    status: row.status as ImportJobRecord['status'],
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    generation: Number(row.generation),
    requested_by: String(row.requested_by),
    space_id: String(row.space_id),
    config_fingerprint: String(row.config_fingerprint ?? ''),
    worker_id: row.worker_id == null ? null : String(row.worker_id),
    lease_expires_at: date(row.lease_expires_at),
    next_run_at: new Date(row.next_run_at as string | Date),
    error: row.error == null ? null : String(row.error),
    created_at: new Date(row.created_at as string | Date),
    started_at: date(row.started_at),
    finished_at: date(row.finished_at),
    updated_at: new Date(row.updated_at as string | Date),
  };
}
