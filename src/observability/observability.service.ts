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
import {
  ObservabilityRepository,
  type FeedbackRecord,
  type TraceRecord,
} from './observability.repository.js';

@Injectable()
export class ObservabilityService {
  private readonly traces = new Map<string, TraceRecord>();
  private readonly feedback: FeedbackRecord[] = [];
  private readonly repository: ObservabilityRepository;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfig,
  ) {
    this.repository = new ObservabilityRepository(database);
  }

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
      await this.repository.insertTrace(record);
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
      await this.repository.complete(traceId, toolName, hasEvidence, generationMs, error);
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
      await this.repository.insertFeedback(randomUUID().replaceAll('-', ''), record);
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
      const trace = await this.repository.findScoped(traceId, context.user_id, context.space_id);
      return trace ? serializeTrace(trace) : null;
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
    return this.repository.listScoped(
      context.space_id,
      from,
      userScoped ? context.user_id : undefined,
    );
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
