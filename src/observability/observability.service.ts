import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  AccessContext,
  Citation,
  FeedbackAction,
  RetrievalTrace,
} from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';

interface TraceRecord {
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

interface FeedbackRecord {
  trace_id: string;
  user_id: string;
  space_id: string;
  action: FeedbackAction;
  comment: string;
  created_at: Date;
}

@Injectable()
export class ObservabilityService {
  private readonly traces = new Map<string, TraceRecord>();
  private readonly feedback: FeedbackRecord[] = [];

  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  async recordSearch(
    trace: RetrievalTrace,
    context: AccessContext | null,
    query: string,
    citations: Citation[],
    entrypoint = 'knowledge_search',
  ): Promise<void> {
    const record: TraceRecord = {
      trace_id: trace.trace_id,
      user_id: context?.user_id ?? null,
      space_id: context?.space_id ?? null,
      entrypoint,
      query: query.slice(0, 1000),
      mode: trace.mode,
      tool_name: null,
      status: 'search',
      has_evidence: null,
      retrieval_ms: trace.total_ms,
      generation_ms: 0,
      citation_count: citations.length,
      inserted: false,
      helpful_state: null,
      model_name: this.config.llmModel,
      collection_name: this.config.qdrantCollection,
      payload: {
        trace,
        citations: citations.map((citation) => ({
          index: citation.index,
          doc_id: citation.doc_id,
          chunk_id: citation.chunk_id,
          document_version: citation.document_version,
          title: citation.title,
        })),
      },
      error: null,
      created_at: new Date(),
      completed_at: null,
    };
    if (this.database.observabilityEnabled) {
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
    } else this.traces.set(trace.trace_id, record);
  }

  async recordCompletion(
    traceId: string,
    toolName: string,
    hasEvidence: boolean,
    generationMs = 0,
    error: string | null = null,
  ): Promise<void> {
    if (this.database.observabilityEnabled) {
      await this.database.query(
        `UPDATE rag_traces SET tool_name=?, status=?, has_evidence=?, generation_ms=?,
         error=?, completed_at=UTC_TIMESTAMP(6) WHERE trace_id=?`,
        [toolName, error ? 'error' : 'completed', hasEvidence, generationMs, error?.slice(0, 2000) ?? null, traceId],
      );
      return;
    }
    const current = this.traces.get(traceId);
    if (!current) return;
    this.traces.set(traceId, {
      ...current,
      tool_name: toolName,
      status: error ? 'error' : 'completed',
      has_evidence: hasEvidence,
      generation_ms: generationMs,
      error: error?.slice(0, 2000) ?? null,
      completed_at: new Date(),
    });
  }

  async recordFeedback(
    traceId: string,
    action: FeedbackAction,
    context: AccessContext,
    comment: string,
  ): Promise<boolean> {
    const trace = await this.getTrace(traceId, context);
    if (!trace) return false;
    const record: FeedbackRecord = {
      trace_id: traceId,
      user_id: context.user_id,
      space_id: context.space_id,
      action,
      comment,
      created_at: new Date(),
    };
    if (this.database.observabilityEnabled) {
      await this.database.query(
        `INSERT INTO rag_feedback_events
          (event_id,trace_id,user_id,space_id,action,comment,created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID().replaceAll('-', ''), traceId, context.user_id, context.space_id, action, comment, record.created_at],
      );
      if (action === 'inserted') {
        await this.database.query('UPDATE rag_traces SET inserted=TRUE WHERE trace_id=?', [traceId]);
      } else if (action === 'helpful' || action === 'unhelpful') {
        await this.database.query('UPDATE rag_traces SET helpful_state=? WHERE trace_id=?', [action, traceId]);
      }
    } else this.feedback.push(record);
    if (!this.database.observabilityEnabled) {
      const current = this.traces.get(traceId);
      if (current) {
        this.traces.set(traceId, {
          ...current,
          inserted: current.inserted || action === 'inserted',
          helpful_state:
            action === 'helpful' || action === 'unhelpful' ? action : current.helpful_state,
        });
      }
    }
    return true;
  }

  async snapshot(context: AccessContext, window: string, queueDepth: number) {
    const hours = windowHours(window);
    const from = new Date(Date.now() - hours * 60 * 60 * 1000);
    const traces = await this.scopedTraces(context, from);
    const completed = traces.filter((item) => ['completed', 'error'].includes(item.status));
    const evidence = completed.filter((item) => item.has_evidence === true);
    const retrieval = traces.map((item) => item.retrieval_ms);
    const generation = completed.map((item) => item.generation_ms);
    const inserted = evidence.filter((item) => item.inserted).length;
    return {
      search_count: traces.length,
      completion_count: completed.length,
      evidence_completion_count: evidence.length,
      no_evidence_rate: ratio(completed.filter((item) => item.has_evidence === false).length, completed.length),
      p50_latency_ms: percentile(retrieval, 0.5),
      p95_latency_ms: percentile(retrieval, 0.95),
      inserted_count: inserted,
      adoption_rate: ratio(inserted, evidence.length),
      helpful_count: completed.filter((item) => item.helpful_state === 'helpful').length,
      unhelpful_count: completed.filter((item) => item.helpful_state === 'unhelpful').length,
      window,
      from_time: from,
      to_time: new Date(),
      p50_generation_ms: percentile(generation, 0.5),
      p95_generation_ms: percentile(generation, 0.95),
      error_rate: ratio(completed.filter((item) => item.status === 'error').length, completed.length),
      queue_depth: queueDepth,
    };
  }

  async listTraces(context: AccessContext, window: string, limit: number) {
    const from = new Date(Date.now() - windowHours(window) * 60 * 60 * 1000);
    const items = (await this.scopedTraces(context, from, true)).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return {
      items: items.slice(0, limit).map(traceSummary),
      total: items.length,
    };
  }

  async getTrace(traceId: string, context: AccessContext): Promise<Record<string, unknown> | null> {
    if (this.database.observabilityEnabled) {
      const rows = await this.database.query<Record<string, unknown>>(
        'SELECT * FROM rag_traces WHERE trace_id=? AND user_id=? AND space_id=?',
        [traceId, context.user_id, context.space_id],
      );
      return rows[0] ? serializeTrace(mapTrace(rows[0])) : null;
    }
    const trace = this.traces.get(traceId);
    return trace && trace.user_id === context.user_id && trace.space_id === context.space_id
      ? serializeTrace(trace)
      : null;
  }

  private async scopedTraces(context: AccessContext, from: Date, userScoped = false): Promise<TraceRecord[]> {
    if (!this.database.observabilityEnabled) {
      return [...this.traces.values()].filter(
        (item) =>
          item.space_id === context.space_id &&
          (!userScoped || item.user_id === context.user_id) &&
          item.created_at >= from,
      );
    }
    const userClause = userScoped ? ' AND user_id=?' : '';
    const params: unknown[] = userScoped
      ? [context.space_id, from, context.user_id]
      : [context.space_id, from];
    return (
      await this.database.query<Record<string, unknown>>(
        `SELECT * FROM rag_traces WHERE space_id=? AND created_at>=?${userClause}`,
        params,
      )
    ).map(mapTrace);
  }
}

export function windowHours(window: string): number {
  const allowed: Record<string, number> = { '24h': 24, '7d': 168, '30d': 720 };
  const value = allowed[window];
  if (!value) throw new Error(`Unsupported metrics window: ${window}`);
  return value;
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const floor = Math.floor(position);
  const fraction = position - floor;
  const index = fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(position);
  return Math.round((sorted[Math.min(sorted.length - 1, index)] ?? 0) * 100) / 100;
}

function traceSummary(item: TraceRecord) {
  return {
    trace_id: item.trace_id,
    user_id: item.user_id,
    space_id: item.space_id,
    query: item.query,
    mode: item.mode,
    tool_name: item.tool_name,
    status: item.status,
    has_evidence: item.has_evidence,
    retrieval_ms: item.retrieval_ms,
    generation_ms: item.generation_ms,
    citation_count: item.citation_count,
    error: item.error,
    created_at: item.created_at,
  };
}

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
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>),
    error: row.error == null ? null : String(row.error),
    created_at: new Date(row.created_at as string | number | Date),
    completed_at: row.completed_at == null ? null : new Date(row.completed_at as string | number | Date),
  };
}

function serializeTrace(item: TraceRecord): Record<string, unknown> {
  return {
    trace_id: item.trace_id,
    user_id: item.user_id,
    space_id: item.space_id,
    entrypoint: item.entrypoint,
    query: item.query,
    mode: item.mode,
    tool_name: item.tool_name,
    status: item.status,
    has_evidence: item.has_evidence,
    inserted: item.inserted,
    helpful_state: item.helpful_state,
    retrieval_ms: item.retrieval_ms,
    generation_ms: item.generation_ms,
    citation_count: item.citation_count,
    trace: item.payload.trace ?? {},
    citations: item.payload.citations ?? [],
    model_name: item.model_name,
    collection_name: item.collection_name,
    error: item.error,
    created_at: item.created_at,
    completed_at: item.completed_at,
  };
}
