import type { AgentRunRecord } from './agent-audit.service.js';
import type { AgentSpan } from './agent-execution.js';

export interface AgentMetricRun extends AgentRunRecord {
  created_at?: Date | string;
  completed_at?: Date | string | null;
  active_ms?: number;
  budget?: Record<string, number> | null;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

/** Execution delivery and user acceptance have separate denominators. */
export function summarizeAgentRuns(runs: AgentMetricRun[]) {
  const delivered = runs.filter((run) => ['completed', 'awaiting_review'].includes(run.status) && Boolean(run.payload.delivery?.result));
  const terminal = runs.filter((run) => ['completed', 'awaiting_review', 'failed', 'stopped'].includes(run.status));
  const failed = runs.filter((run) => run.status === 'failed');
  const spans: AgentSpan[] = runs.flatMap((run) => run.payload.traces ?? []);
  const modelSpans = spans.filter((span) => span.kind === 'model');
  const toolSpans = spans.filter((span) => span.kind === 'tool');
  const tokens = runs.reduce((sum, run) => {
    const usage = run.budget ?? run.payload.usage ?? {};
    return sum + Number(usage.prompt_tokens ?? 0) + Number(usage.completion_tokens ?? 0);
  }, 0);
  const requests = runs.reduce((sum, run) => sum + Number((run.budget ?? run.payload.usage)?.model_requests ?? 0), 0);
  const feedback = delivered.flatMap((run) => Object.entries(run.payload.feedback ?? {})
    .filter(([key]) => key !== 'answer').map(([, action]) => action));
  const decided = feedback.filter((action) => ['accepted', 'rejected', 'created', 'discarded'].includes(String(action)));
  const accepted = decided.filter((action) => action === 'accepted' || action === 'created');
  const durations = terminal.map((run) => {
    if (run.active_ms != null) return Number(run.active_ms);
    return Number(run.payload.duration_ms);
  }).filter((value) => Number.isFinite(value) && value >= 0);
  const errors: Record<string, number> = {};
  for (const span of spans.filter((span) => span.status === 'error')) {
    const code = span.error_code ?? 'UNKNOWN';
    errors[code] = (errors[code] ?? 0) + 1;
  }
  const byModel = [...new Set(modelSpans.map((span) => String(span.attributes.model ?? 'unknown')))].map((model) => {
    const attempts = modelSpans.filter((span) => String(span.attributes.model ?? 'unknown') === model);
    const known = attempts.filter((span) => typeof span.attributes.prompt_tokens === 'number' &&
      typeof span.attributes.completion_tokens === 'number');
    return { model, attempts: attempts.length, failed_attempts: attempts.filter((span) => span.status === 'error').length,
      known_usage_attempts: known.length, unknown_usage_attempts: attempts.length - known.length,
      prompt_tokens: known.length ? known.reduce((sum, span) => sum + Number(span.attributes.prompt_tokens), 0) : null,
      completion_tokens: known.length ? known.reduce((sum, span) => sum + Number(span.attributes.completion_tokens), 0) : null,
      p95_ms: percentile(attempts.map((span) => span.duration_ms).filter((value): value is number => value != null), 0.95) };
  });
  return {
    run_count: runs.length, terminal_runs: terminal.length, delivered_runs: delivered.length,
    failed_runs: failed.length, awaiting_input_runs: runs.filter((run) => ['waiting_input', 'needs_input'].includes(run.status)).length,
    execution_success_rate: terminal.length ? delivered.length / terminal.length : null,
    feedback_decisions: decided.length, accepted_candidates: accepted.length,
    adoption_rate: decided.length ? accepted.length / decided.length : null,
    model_requests: requests, model_attempts_traced: modelSpans.length,
    retries: modelSpans.filter((span) => Number(span.attributes.attempt ?? 1) > 1).length,
    reported_tokens: tokens, reported_tokens_per_delivered_run: delivered.length ? tokens / delivered.length : null,
    estimated_requests: runs.reduce((sum, run) => sum + Number((run.budget ?? run.payload.usage)?.estimated_requests ?? 0), 0),
    charged_tokens_including_estimates: runs.reduce((sum, run) => sum + Number((run.budget ?? run.payload.usage)?.charged_tokens ?? 0), 0),
    tool_calls_traced: toolSpans.length, failed_tool_calls: toolSpans.filter((span) => span.status === 'error').length,
    context: {
      compactions: spans.filter((span) => span.kind === 'worker' && span.name === 'context_compaction' && span.status === 'success').length,
      tokens_before: spans.filter((span) => span.kind === 'worker' && span.name === 'context_compaction' && span.status === 'success')
        .reduce((sum, span) => sum + Number(span.attributes.before_tokens ?? 0), 0),
      tokens_after: spans.filter((span) => span.kind === 'worker' && span.name === 'context_compaction' && span.status === 'success')
        .reduce((sum, span) => sum + Number(span.attributes.after_tokens ?? 0), 0),
      evidence_reads: toolSpans.filter((span) => span.name === 'read_task_evidence' && span.status === 'success').length,
      source_failures: toolSpans.filter((span) => span.name === 'read_task_evidence' && span.status === 'error' &&
        ['ACCESS_DENIED', 'SOURCE_UNAVAILABLE', 'SOURCE_CHANGED'].includes(span.error_code ?? '')).length,
    },
    p50_active_ms: percentile(durations, 0.5), p95_active_ms: percentile(durations, 0.95),
    errors_by_code: errors, by_model: byModel,
    by_mode: Object.fromEntries([...new Set(runs.map((run) => run.mode))].map((mode) =>
      [mode, { runs: runs.filter((run) => run.mode === mode).length,
        delivered: delivered.filter((run) => run.mode === mode).length }])),
  };
}
