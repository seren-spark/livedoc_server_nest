/**
 * @file 检索追踪存储。保存检索链路、生成结果与用户反馈，并按访问范围查询。
 */
import type { FeedbackAction } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';

export interface TraceRecord {
  trace_id: string;
  user_id: string | null;
  space_id: string | null;
  entrypoint: string;
  query: string;
  mode: string;
  tool_name: string | null;
  status: string;
  has_evidence: boolean | null;
  retrieval_ms: number;
  generation_ms: number;
  citation_count: number;
  inserted: boolean;
  helpful_state: string | null;
  model_name: string;
  collection_name: string;
  payload: Record<string, unknown>;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface FeedbackRecord {
  trace_id: string;
  user_id: string;
  space_id: string;
  action: FeedbackAction;
  comment: string;
  created_at: Date;
}

const TRACE_COLUMNS = `trace_id,user_id,space_id,entrypoint,query_text,mode,tool_name,status,
  has_evidence,retrieval_ms,generation_ms,citation_count,inserted,helpful_state,
  model_name,collection_name,payload,error,created_at,completed_at`;

export class ObservabilityRepository {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 保存一条检索追踪记录。
   *
   * @param record 待处理的业务记录。
   */
  async insertTrace(record: TraceRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO rag_traces
        (trace_id,user_id,space_id,entrypoint,query_text,mode,status,retrieval_ms,
         generation_ms,citation_count,inserted,helpful_state,model_name,collection_name,payload,created_at)
       VALUES (?,?,?,?,?,?,'search',?,0,?,FALSE,NULL,?,?,?,?)`,
      [
        record.trace_id,
        record.user_id,
        record.space_id,
        record.entrypoint,
        record.query,
        record.mode,
        record.retrieval_ms,
        record.citation_count,
        record.model_name,
        record.collection_name,
        JSON.stringify(record.payload),
        record.created_at,
      ],
    );
  }

  /**
   * 为已有检索追踪补记生成状态、耗时和证据使用情况。
   *
   * @param traceId 检索追踪标识。
   * @param toolName 当前工具的名称。
   * @param hasEvidence 当前结果是否具有可使用的引用依据。
   * @param generationMs 模型生成耗时，单位为毫秒。
   * @param error 本次操作捕获的异常。
   */
  async complete(
    traceId: string,
    toolName: string,
    hasEvidence: boolean,
    generationMs: number,
    error: string | null,
  ): Promise<void> {
    await this.database.query(
      `UPDATE rag_traces SET tool_name=?,status=?,has_evidence=?,generation_ms=?,
       error=?,completed_at=UTC_TIMESTAMP(6) WHERE trace_id=?`,
      [
        toolName,
        error ? 'error' : 'completed',
        hasEvidence,
        generationMs,
        error?.slice(0, 2000) ?? null,
        traceId,
      ],
    );
  }

  /**
   * 保存用户对生成结果的反馈。
   *
   * @param eventId event 对应的唯一标识。
   * @param record 待处理的业务记录。
   */
  async insertFeedback(eventId: string, record: FeedbackRecord): Promise<void> {
    await this.database.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO rag_feedback_events
          (event_id,trace_id,user_id,space_id,action,comment,created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          eventId,
          record.trace_id,
          record.user_id,
          record.space_id,
          record.action,
          record.comment,
          record.created_at,
        ],
      );
      if (record.action === 'inserted') {
        await manager.query('UPDATE rag_traces SET inserted=TRUE WHERE trace_id=?', [record.trace_id]);
      } else if (record.action === 'helpful' || record.action === 'unhelpful') {
        await manager.query(
          'UPDATE rag_traces SET helpful_state=? WHERE trace_id=?',
          [record.action, record.trace_id],
        );
      }
    });
  }

  /**
   * 在指定用户和空间范围内查询单条追踪。
   *
   * @param traceId 检索追踪标识。
   * @param userId 当前用户标识。
   * @param spaceId space 对应的唯一标识。
   * @returns TraceRecord 类型的处理结果；未找到或不可用时可能为空。
   */
  async findScoped(traceId: string, userId: string, spaceId: string): Promise<TraceRecord | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${TRACE_COLUMNS} FROM rag_traces
       WHERE trace_id=? AND user_id=? AND space_id=?`,
      [traceId, userId, spaceId],
    );
    return rows[0] ? mapTrace(rows[0]) : null;
  }

  /**
   * 在指定用户和空间范围内查询追踪列表。
   *
   * @param spaceId space 对应的唯一标识。
   * @param from 编辑区间的起始位置。
   * @param userId 当前用户标识（可选）。
   * @returns 整理后的结果列表。
   */
  async listScoped(
    spaceId: string,
    from: Date,
    userId?: string,
  ): Promise<TraceRecord[]> {
    const userClause = userId ? ' AND user_id=?' : '';
    const params = userId ? [spaceId, from, userId] : [spaceId, from];
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${TRACE_COLUMNS} FROM rag_traces
       WHERE space_id=? AND created_at>=?${userClause}`,
      params,
    );
    return rows.map(mapTrace);
  }
}

/**
 * 将数据库记录还原为检索追踪对象。
 *
 * @param row 数据库查询返回的一行数据。
 * @returns TraceRecord 类型的处理结果。
 */
function mapTrace(row: Record<string, unknown>): TraceRecord {
  return {
    trace_id: String(row.trace_id),
    user_id: row.user_id == null ? null : String(row.user_id),
    space_id: row.space_id == null ? null : String(row.space_id),
    entrypoint: String(row.entrypoint),
    query: String(row.query_text),
    mode: String(row.mode),
    tool_name: row.tool_name == null ? null : String(row.tool_name),
    status: String(row.status),
    has_evidence: row.has_evidence == null ? null : Boolean(row.has_evidence),
    retrieval_ms: Number(row.retrieval_ms),
    generation_ms: Number(row.generation_ms),
    citation_count: Number(row.citation_count),
    inserted: Boolean(row.inserted),
    helpful_state: row.helpful_state == null ? null : String(row.helpful_state),
    model_name: String(row.model_name ?? ''),
    collection_name: String(row.collection_name ?? ''),
    payload: typeof row.payload === 'string'
      ? JSON.parse(row.payload) as Record<string, unknown>
      : row.payload as Record<string, unknown>,
    error: row.error == null ? null : String(row.error),
    created_at: new Date(row.created_at as string | number | Date),
    completed_at: row.completed_at == null
      ? null
      : new Date(row.completed_at as string | number | Date),
  };
}
