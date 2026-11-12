import { describe, expect, test } from '@jest/globals';
import { AgentAuditService } from '../src/ai/agent-audit.service.js';
import { summarizeAgentRuns, type AgentMetricRun } from '../src/ai/agent-metrics.js';

const context = { user_id: 'alice', space_id: 'space', team_ids: [] };
function run(id: string, status = 'completed'): AgentMetricRun {
  return { run_id: id, request_id: id, ...context, conversation_id: 'chat', mode: 'agent', status,
    created_at: new Date(), completed_at: new Date(), active_ms: 100,
    budget: { model_requests: 2, prompt_tokens: 20, completion_tokens: 10 },
    payload: { delivery: { result: { kind: 'edits' } }, traces: [], feedback: {} } };
}

describe('agent operational metrics', () => {
  test('keeps empty observations null and separates delivery from user acceptance', () => {
    expect(summarizeAgentRuns([])).toMatchObject({ execution_success_rate: null, adoption_rate: null, p95_active_ms: null });
    const a = run('a'), b = run('b', 'failed'), c = run('c', 'running');
    a.payload.feedback = { edit: 'accepted', answer: 'helpful' };
    b.payload.delivery = undefined;
    const summary = summarizeAgentRuns([a, b, c]);
    expect(summary).toMatchObject({ run_count: 3, delivered_runs: 1, terminal_runs: 2,
      execution_success_rate: 0.5, feedback_decisions: 1, adoption_rate: 1,
      reported_tokens: 90, model_requests: 6, p95_active_ms: 100 });
  });

  test('aggregates attempt failures and model usage without returning source content', () => {
    const item = run('a');
    item.payload.query = 'private text';
    item.payload.traces = [
      { kind: 'model', status: 'error', error_code: 'UPSTREAM_RATE_LIMIT', duration_ms: 20,
        attributes: { model: 'first', attempt: 1 } },
      { kind: 'model', status: 'success', duration_ms: 10,
        attributes: { model: 'backup', attempt: 2, prompt_tokens: 20, completion_tokens: 10 } },
    ];
    const summary = summarizeAgentRuns([item]);
    expect(summary).toMatchObject({ retries: 1, errors_by_code: { UPSTREAM_RATE_LIMIT: 1 },
      by_model: [{ model: 'first', failed_attempts: 1, unknown_usage_attempts: 1, prompt_tokens: null },
        { model: 'backup', known_usage_attempts: 1, prompt_tokens: 20 }] });
    expect(JSON.stringify(summary)).not.toContain('private text');
  });

  test('does not count human review waiting as active execution and includes old input waits', () => {
    const item = run('legacy', 'needs_input');
    delete item.active_ms;
    item.payload.duration_ms = 200;
    item.created_at = new Date(Date.now() - 600000);
    item.completed_at = new Date();
    expect(summarizeAgentRuns([item])).toMatchObject({ awaiting_input_runs: 1, p95_active_ms: null });
    item.status = 'completed';
    expect(summarizeAgentRuns([item]).p95_active_ms).toBe(200);
    delete item.payload.duration_ms;
    expect(summarizeAgentRuns([item]).p95_active_ms).toBeNull();
  });

  test('isolates metrics by user, space and time, and validates windows', async () => {
    const audit = new AgentAuditService({ metadataEnabled: false } as any);
    const own = run('own'), outsider = run('outside'), expired = run('expired'), otherSpace = run('space');
    outsider.user_id = 'bob';
    otherSpace.space_id = 'other';
    expired.created_at = new Date(Date.now() - 2 * 86400000);
    for (const item of [own, outsider, expired, otherSpace]) audit.runs.set(item.run_id, item);
    expect(await audit.metrics(context)).toMatchObject({ run_count: 1, truncated: false });
    await expect(audit.metrics(context, 'all')).rejects.toThrow('统计窗口');
  });

  test('uses owner-scoped bounded SQL and parses persisted JSON', async () => {
    const item = run('db');
    let parameters: unknown[] = [];
    const audit = new AgentAuditService({ metadataEnabled: true, query: async (sql: string, values: unknown[]) => {
      expect(sql).toContain('user_id=? AND space_id=?');
      expect(sql).toContain('LIMIT 501');
      parameters = values;
      return [{ ...item, payload: JSON.stringify(item.payload), budget: JSON.stringify(item.budget) }];
    } } as any);
    expect(await audit.metrics(context)).toMatchObject({ run_count: 1, model_requests: 2 });
    expect(parameters.slice(0, 2)).toEqual(['alice', 'space']);
  });
});
