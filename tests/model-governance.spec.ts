import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { AppConfig } from '../src/config/app-config.js';
import { LlmService } from '../src/ai/llm.service.js';
import { AgentExecutionError } from '../src/ai/agent-execution.js';
import { modelHttpFailure } from '../src/ai/model-routing.js';

const previousA = process.env.TEST_MODEL_A_KEY;
const previousB = process.env.TEST_MODEL_B_KEY;
function config() {
  process.env.TEST_MODEL_A_KEY = 'private-model-a';
  process.env.TEST_MODEL_B_KEY = 'private-model-b';
  return Object.assign(new AppConfig(), {
    llmApiKey: 'legacy-key', llmModel: 'legacy-model', thinkingSupported: false,
    llmModelProfiles: {
      primary: { model: 'main-a', base_url: 'https://a.example/v1', api_key_env: 'TEST_MODEL_A_KEY',
        extra_body: { temperature: 1 }, thinking: 'toggle',
        thinking_on_body: { enable_thinking: true }, thinking_off_body: { enable_thinking: false } },
      backup: { model: 'main-b', base_url: 'https://b.example/v1', api_key_env: 'TEST_MODEL_B_KEY',
        thinking: 'toggle', thinking_on_body: { reasoning_effort: 'medium' }, thinking_off_body: { reasoning_effort: 'none' } },
    },
    agentModelRoutes: { main: ['primary', 'backup'], critic: ['backup'] },
  });
}
const tool = { type: 'function' as const, function: { name: 'finish_answer', description: 'answer', parameters: { type: 'object' } } };
const ok = () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
afterEach(() => {
  jest.restoreAllMocks();
  if (previousA === undefined) delete process.env.TEST_MODEL_A_KEY; else process.env.TEST_MODEL_A_KEY = previousA;
  if (previousB === undefined) delete process.env.TEST_MODEL_B_KEY; else process.env.TEST_MODEL_B_KEY = previousB;
});

describe('model routing and provider isolation', () => {
  test('uses independent role endpoints, credentials, sampling and thinking bodies', async () => {
    const llm = new LlmService(config());
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const body = JSON.parse(String(options?.body));
      if (url === 'https://a.example/v1/chat/completions') {
        expect(options?.headers).toMatchObject({ Authorization: 'Bearer private-model-a' });
        expect(body).toMatchObject({ model: 'main-a', temperature: 1, enable_thinking: true });
      } else {
        expect(url).toBe('https://b.example/v1/chat/completions');
        expect(options?.headers).toMatchObject({ Authorization: 'Bearer private-model-b' });
        expect(body).toMatchObject({ model: 'main-b', reasoning_effort: 'none' });
        expect(body.enable_thinking).toBeUndefined();
      }
      return ok();
    });
    await llm.agentTurn([], [tool], undefined, { thinking: true, thinkingBody: { enable_thinking: false } });
    await llm.agentTurn([], [], undefined, { role: 'critic', thinking: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(llm.agentAttempt())).not.toContain('private-model');
  });

  test('preserves reasoning for the same profile and strips it from a cross-provider continuation', async () => {
    const llm = new LlmService(config());
    const bodies: any[] = [];
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body)));
      if (bodies.length === 1) return Response.json({ choices: [{ message: {
        content: null, reasoning_content: 'internal-a-only',
        tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'finish_answer', arguments: '{"answer":"done"}' } }],
      } }] });
      return ok();
    });
    const first = await llm.agentTurn([{ role: 'user', content: 'input' }], [tool], undefined,
      { profile: 'primary', thinking: true });
    const continuation = [first.message, { role: 'tool' as const, tool_call_id: 'call-a', content: 'observed result' }];
    await llm.agentTurn(continuation, [tool], undefined, { profile: 'primary', thinking: true });
    await llm.agentTurn(continuation, [tool], undefined, { profile: 'backup', thinking: true });
    expect(first.message).not.toHaveProperty('reasoning_content');
    expect(bodies[1].messages[0].reasoning_content).toBe('internal-a-only');
    expect(bodies[2].messages[0]).not.toHaveProperty('reasoning_content');
    expect(JSON.stringify(bodies[2])).not.toContain('internal-a-only');
    expect(bodies[2].messages[1].content).toBe('observed result');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('filters unsupported capabilities before HTTP dispatch', async () => {
    const configured = config();
    Object.assign((configured.llmModelProfiles as any).primary, { tools: false, thinking: 'always_on' });
    const llm = new LlmService(configured);
    expect(llm.agentAttempt({ json: true }, 1).profile).toBe('backup');
    expect(llm.agentAttempt({ thinking: true }, 0).profile).toBe('primary');
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await expect(llm.agentTurn([], [tool], undefined, { profile: 'primary', thinking: true }))
      .rejects.toMatchObject({ code: 'MODEL_CAPABILITY_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('skips an insufficient context window without spending an HTTP attempt', () => {
    const configured = config();
    Object.assign((configured.llmModelProfiles as any).primary, { context_window: 2048 });
    const llm = new LlmService(configured);
    expect(llm.agentAttempt({ requiredContextTokens: 4096 }).profile).toBe('backup');
    expect(() => llm.agentAttempt({ requiredContextTokens: 1000000 })).toThrow('没有满足');
  });

  test('performs one HTTP per turn and allows a separately budgeted fallback after quota failure', async () => {
    const llm = new LlmService(config());
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { code: 'Arrearage', message: 'private provider diagnostics' } }, { status: 400 }))
      .mockResolvedValueOnce(ok());
    const first = llm.agentAttempt();
    let failure: unknown;
    try { await llm.agentTurn([], [], undefined, { profile: first.profile }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'UPSTREAM_QUOTA', retryable: false });
    expect(String(failure)).not.toContain('private provider');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(llm.canFallback(failure)).toBe(true);
    const second = llm.agentAttempt({}, 0, [first.profile!]);
    expect(second.profile).toBe('backup');
    await llm.agentTurn([], [], undefined, { profile: second.profile });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(llm.agentAttempt().profile).toBe('backup');
  });

  test('opens a bounded circuit and permits one probe after cooldown', async () => {
    const configured = config();
    Object.assign(configured, { llmCircuitFailureThreshold: 1, llmCircuitCooldownMs: 1000, agentModelRoutes: { main: ['primary'] } });
    const llm = new LlmService(configured);
    const now = jest.spyOn(Date, 'now').mockReturnValue(10000);
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(llm.agentTurn([], [])).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR' });
    expect(() => llm.agentAttempt()).toThrow('冷却');
    expect(fetch).toHaveBeenCalledTimes(1);
    now.mockReturnValue(11001);
    fetch.mockResolvedValueOnce(ok());
    await llm.agentTurn([], []);
    expect(llm.agentAttempt().profile).toBe('primary');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    [401, '', 'UPSTREAM_AUTH', false], [429, '', 'UPSTREAM_RATE_LIMIT', true],
    [400, 'invalid_parameter_error', 'UPSTREAM_PARAMETER', false], [503, '', 'UPSTREAM_HTTP_ERROR', true],
  ])('classifies upstream status %s without exposing the body', async (status, providerCode, code, retryable) => {
    const failure = await modelHttpFailure(Response.json({ error: { code: providerCode, message: 'private' } }, { status }));
    expect(failure).toMatchObject({ code, retryable });
    expect(failure.message).not.toContain('private');
    if (code === 'UPSTREAM_PARAMETER') expect(new LlmService(config()).canFallback(failure)).toBe(false);
  });

  test('changes configuration fingerprint when capabilities, routes or credentials change', () => {
    const configured = config();
    const before = new LlmService(configured).configurationFingerprint();
    process.env.TEST_MODEL_A_KEY = 'rotated-key';
    expect(new LlmService(configured).configurationFingerprint()).not.toBe(before);
    process.env.TEST_MODEL_A_KEY = 'private-model-a';
    Object.assign((configured.llmModelProfiles as any).primary, { json: false });
    expect(new LlmService(configured).configurationFingerprint()).not.toBe(before);
    expect(() => new LlmService(Object.assign(configured, { agentModelRoutes: { main: ['missing'] } }))).toThrow('AGENT_MODEL_ROUTES');
  });

  test('keeps native search credentials separate from a main model profile', async () => {
    const configured = Object.assign(config(), { agentWebSearchUrl: 'https://search.example/native', agentWebSearchModel: 'native-search' });
    const llm = new LlmService(configured);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(url).toBe('https://search.example/native');
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer legacy-key' });
      return Response.json({ output: { search_info: { search_results: [{ index: 1, title: 'source', url: 'https://source.example' }] } } });
    });
    expect((await llm.searchWeb('query')).sources).toHaveLength(1);
  });

  test('uses a main profile for direct completion without implicit retries', async () => {
    const llm = new LlmService(config());
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(url).toBe('https://a.example/v1/chat/completions');
      expect(JSON.parse(String(options?.body))).toMatchObject({ model: 'main-a', temperature: 1, enable_thinking: false });
      return ok();
    });
    expect(await llm.complete('text')).toBe('{"ok":true}');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('keeps missing-model HTTP compatibility and does not send a request', async () => {
    const configured = Object.assign(config(), { llmApiKey: '', llmModelProfiles: {}, agentModelRoutes: {} });
    const llm = new LlmService(configured);
    const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(llm.complete('text')).rejects.toMatchObject({ status: 503 });
    await expect(llm.stream('text').next()).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a configured classifier is independent of unavailable main credentials', async () => {
    const configured = config();
    Object.assign(configured, { agentModelRoutes: { main: ['primary'], classifier: ['backup'] } });
    process.env.TEST_MODEL_A_KEY = '';
    const llm = new LlmService(configured);
    expect(llm.isConfigured).toBe(false);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      expect(url).toBe('https://b.example/v1/chat/completions');
      return ok();
    });
    expect((await llm.agentTurn([], [], undefined, { role: 'classifier' })).message.content).toBe('{"ok":true}');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('filters tool capability for the existing document-memory entry point', async () => {
    const configured = config();
    Object.assign((configured.llmModelProfiles as any).primary, { tools: false });
    const llm = new LlmService(configured);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      expect(url).toBe('https://b.example/v1/chat/completions');
      return Response.json({ choices: [{ message: { tool_calls: [{ function: {
        arguments: '{"glossary":[],"style_tags":[],"global_settings":[]}',
      } }] } }] });
    });
    expect(await llm.extractDocumentMemory([{ hash: 'hash', anchor: 'p', content: 'source' }]))
      .toEqual({ glossary: [], style_tags: [], global_settings: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
