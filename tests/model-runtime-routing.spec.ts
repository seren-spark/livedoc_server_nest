import { describe, expect, jest, test } from '@jest/globals';
import { AppConfig } from '../src/config/app-config.js';
import { LlmService } from '../src/ai/llm.service.js';
import { AgentRuntimeService } from '../src/ai/agent-runtime.service.js';
import { emptyUsage, type WorkerEnvironment } from '../src/ai/agent-runtime.types.js';
import type { AgentSpan } from '../src/ai/agent-execution.js';
import { request } from './fixtures/agent-request.js';
import { ModelRouter } from '../src/ai/model-routing.js';

function harness() {
  const config = new AppConfig();
  Object.assign(config, { llmApiKey: 'test', llmModelProfiles: {
    primary: { model: 'model-a', base_url: 'https://a.invalid/v1', context_window: 8192 },
    backup: { model: 'model-b', base_url: 'https://b.invalid/v1', context_window: 8192 },
  }, agentModelRoutes: { main: ['primary', 'backup'] }, agentFinalizationTokens: 0 });
  const llm = new LlmService(config);
  const runtime = new AgentRuntimeService(config, llm, {} as any, {} as any, {} as any);
  const traces: AgentSpan[] = [];
  const environment: WorkerEnvironment = { run_id: 'run', task_id: 'primary', request: request(),
    context: { user_id: 'alice', space_id: 'space', team_ids: [] },
    personal: { thinking_supported: false, deployment_web: false } as any,
    signal: new AbortController().signal, budget: emptyUsage(), traces, emit: () => {} };
  return { config, runtime, environment, traces };
}
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });
const quota = () => new Response(JSON.stringify({ error: { code: 'Arrearage' } }), { status: 400 });

describe('model routing through the budgeted runtime', () => {
  test('research duties reuse existing role routes unless explicitly configured', () => {
    const h = harness();
    Object.assign(h.config, { agentModelRoutes: { main: ['primary'], plan: ['backup'], critic: ['backup'], writer: ['backup'] } });
    const router = new ModelRouter(h.config);
    expect(router.select({ role: 'researcher' }).model).toBe('model-a');
    expect(router.select({ role: 'web_summary' }).model).toBe('model-b');
    expect(router.select({ role: 'research_compressor' }).model).toBe('model-b');
    expect(router.select({ role: 'coverage' }).model).toBe('model-b');
    expect(router.select({ role: 'writer' }).model).toBe('model-b');
  });
  test('selects an initially compatible context window before charging a request', async () => {
    const h = harness();
    Object.assign((h.config.llmModelProfiles as any).primary, { context_window: 1024 });
    const runtime = new AgentRuntimeService(h.config, new LlmService(h.config), {} as any, {} as any, {} as any);
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(success());
    try {
      await runtime.turn(h.environment, [], []);
      expect(fetch.mock.calls[0]![0]).toBe('https://b.invalid/v1/chat/completions');
      expect(h.environment.budget.model_requests).toBe(1);
    } finally { fetch.mockRestore(); }
  });
  test('a quota fallback charges each actual request and traces the selected provider', async () => {
    const h = harness();
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(quota()).mockResolvedValueOnce(success());
    try {
      expect(await h.runtime.turn(h.environment, [{ role: 'user', content: 'private input' }], []))
        .toMatchObject({ content: 'ok' });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://a.invalid/v1/chat/completions', 'https://b.invalid/v1/chat/completions']);
      expect(h.environment.budget).toMatchObject({ model_requests: 2, estimated_requests: 1, reserved_tokens: 0 });
      expect(h.traces.map((span) => [span.attributes.model_profile, span.status]))
        .toEqual([['primary', 'error'], ['backup', 'success']]);
      expect(JSON.stringify(h.traces)).not.toContain('private input');
    } finally { fetch.mockRestore(); }
  });

  test('single-attempt extraction and successful responses never trigger extra requests', async () => {
    const h = harness();
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(quota());
    try {
      await expect(h.runtime.turn(h.environment, [], [], { maxAttempts: 1 })).rejects.toMatchObject({ code: 'UPSTREAM_QUOTA' });
      expect(fetch).toHaveBeenCalledTimes(1);
      const fresh = harness();
      fetch.mockReset().mockResolvedValueOnce(success());
      await fresh.runtime.turn(fresh.environment, [], []);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });

  test('skips fallback profiles whose context window cannot hold the current task', async () => {
    const h = harness();
    Object.assign(h.config, { llmModelProfiles: { ...h.config.llmModelProfiles,
      small: { model: 'small', base_url: 'https://small.invalid/v1', context_window: 1024 },
    }, agentModelRoutes: { main: ['primary', 'small', 'backup'] } });
    const llm = new LlmService(h.config);
    const runtime = new AgentRuntimeService(h.config, llm, {} as any, {} as any, {} as any);
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(quota()).mockResolvedValueOnce(success());
    try {
      await runtime.turn(h.environment, [], []);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://a.invalid/v1/chat/completions', 'https://b.invalid/v1/chat/completions']);
      expect(h.environment.budget.model_requests).toBe(2);
    } finally { fetch.mockRestore(); }
  });
});
