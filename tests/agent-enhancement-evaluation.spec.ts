import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { businessModel, resetBusinessModelState } from '../scripts/agent-business-model.js';

const runner = resolve('scripts/evaluate-agent-business.ts');
const validate = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
  ['--loader', 'ts-node/esm/transpile-only', runner, '--validate-only', ...args],
  { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());

describe('Agent enhancement evaluation protocol', () => {
  test('preserves the original business and switching datasets', () => {
    expect(validate()).toMatchObject({ valid: true, cases: 20, real_cases: 5 });
    expect(validate('--switching')).toMatchObject({ valid: true, cases: 6, real_cases: 6 });
  });

  test('validates the enhancement dataset and filters by feature and case', () => {
    const dataset = JSON.parse(readFileSync(resolve('evals/agent-enhancement-cases.json'), 'utf8'));
    const report = validate('--enhancements', '--feature', 'verification');
    expect(report).toMatchObject({ valid: true, cases: 7, real_cases: 1, suite: 'enhancements', features: ['verification'] });
    expect(report.case_ids).toEqual(dataset.filter((item: { feature: string }) => item.feature === 'verification')
      .map((item: { id: string }) => item.id));
    expect(validate('--enhancements', '--feature', 'verification', '--case', 'verify-recheck')).toMatchObject({
      valid: true, cases: 1, case_ids: ['verify-recheck'],
    });
  });

  test('keeps Skills separately selectable with one real representative task', () => {
    expect(validate('--enhancements', '--feature', 'skills')).toMatchObject({
      valid: true, cases: 7, real_cases: 1, features: ['skills'],
      case_ids: ['skill-technical', 'skill-meeting', 'skill-comparison', 'skill-management',
        'skill-permission', 'skill-snapshot-restart', 'skill-suggestions'],
    });
  });

  test('keeps preference memory separately selectable with one real representative task', () => {
    expect(validate('--enhancements', '--feature', 'memory')).toMatchObject({
      valid: true, cases: 8, real_cases: 1, features: ['memory'],
      case_ids: ['pref-explicit-cross-session', 'pref-current-request', 'pref-candidate-confirm',
        'pref-candidate-reject', 'pref-conflict-replace', 'pref-management', 'pref-isolation', 'pref-snapshot-restart'],
    });
  });

  test('keeps original-evidence context tasks separately selectable', () => {
    expect(validate('--enhancements', '--feature', 'context')).toMatchObject({
      valid: true, cases: 5, real_cases: 1, features: ['context'],
      case_ids: ['context-compaction-retrieval', 'context-snapshot-restart', 'context-unknown-citation',
        'context-source-version', 'context-edit-read-proof'],
    });
  });

  test('rejects incompatible suites and unknown or empty selections', () => {
    for (const args of [
      ['--enhancements', '--switching'],
      ['--enhancements', '--capacity'],
      ['--feature', 'verification'],
      ['--enhancements', '--feature', 'unknown'],
      ['--enhancements', '--feature', 'skills', '--case', 'verify-correct'],
      ['--enhancements', '--case', 'missing'],
    ]) expect(() => validate(...args)).toThrow();
  });
});

describe('controlled evidence verification responses', () => {
  beforeEach(() => resetBusinessModelState());
  const turn = async (purpose: string, scenario: string, answer: string, version = 0) => {
    const response = await businessModel([{ role: 'user', content: JSON.stringify({ purpose,
      request: { query: `[evaluation:${scenario}]` }, candidate_version: version,
      candidate: { kind: 'answer', answer, citation_ids: ['source-1'] },
      evidence: [['source-1', 'Orion 项目的负责人为陈青，回滚窗口为48小时。预算未记录。']],
    }) }]);
    return JSON.parse(response.message.content ?? '{}');
  };

  test('distinguishes supported output and repairable unsupported facts', async () => {
    expect(await turn('evidence_verification', 'verify-correct', 'Orion 的负责人为陈青，回滚窗口48小时。')).toMatchObject({
      candidate_version: 0, passed: true, recovery: { action: 'none' },
    });
    expect(await turn('evidence_verification', 'verify-unsupported', 'Orion 的预算为999万元。')).toMatchObject({
      passed: false, claims: [{ status: 'unsupported' }], recovery: { action: 'repair', claim_ids: ['claim-orion'] },
    });
    const repaired = await turn('evidence_repair', 'verify-unsupported', 'Orion 的预算为999万元。');
    expect(repaired.answer).toContain('预算未记录');
    expect(await turn('evidence_verification', 'verify-unsupported', repaired.answer, 1)).toMatchObject({
      candidate_version: 1, passed: true,
    });
  });

  test('a deliberately bad repair still fails the second check', async () => {
    const repaired = await turn('evidence_repair', 'verify-recheck', '回滚窗口72小时。');
    expect(repaired.answer).toContain('96小时');
    expect(await turn('evidence_verification', 'verify-recheck', repaired.answer, 1)).toMatchObject({
      candidate_version: 1, passed: false,
    });
  });

  test('injects one recoverable verifier interruption per controlled query', async () => {
    await expect(turn('evidence_verification', 'verify-error-interrupted', '负责人为陈青。')).rejects.toThrow('CONTROLLED_VERIFICATION_UNAVAILABLE');
    expect(await turn('evidence_verification', 'verify-error-interrupted', '负责人为陈青。')).toMatchObject({ passed: true });
  });

  test('identifies the affected dependency for bounded local rerunning', async () => {
    expect(await turn('evidence_verification', 'verify-local-rerun', '回滚窗口72小时。')).toMatchObject({
      passed: false, claims: [{ step_ids: ['read_window'] }], recovery: { action: 'rerun', step_ids: ['read_window'] },
    });
  });

  test('returns one exact-position claim per AST segment in a document candidate', async () => {
    const markdown = '# 技术文章\n\nOrion 回滚窗口为48小时。[source-1]\n\n```ts\nconst retry = 3;\n```';
    const bodyStart = markdown.indexOf('Orion');
    const codeStart = markdown.indexOf('```');
    const segments = [
      { location: { field: 'markdown', start: bodyStart, end: markdown.indexOf('\n\n', bodyStart) },
        text: markdown.slice(bodyStart, markdown.indexOf('\n\n', bodyStart)) },
      { location: { field: 'markdown', start: codeStart, end: markdown.length },
        text: markdown.slice(codeStart), inline_citation_required: false },
    ];
    const response = await businessModel([{ role: 'user', content: JSON.stringify({ purpose: 'evidence_verification',
      candidate_version: 0, candidate: { kind: 'document', document_id: 'candidate', title: '技术文章', markdown, citation_ids: ['source-1'] },
      segments, evidence: [{ id: 'source-1', content: 'Orion 回滚窗口48小时，const retry = 3;' }],
    }) }]);
    const report = JSON.parse(response.message.content!);
    expect(report.claims).toHaveLength(2);
    expect(report.claims.map((claim: any) => ({ location: claim.location, text: claim.text })))
      .toEqual(segments.map(({ location, text }) => ({ location, text })));
    expect(report.claims.every((claim: any) => claim.status === 'supported')).toBe(true);
  });

  test('selected technical Skill produces a new-document proposal that preserves code', async () => {
    const response = await businessModel([{ role: 'user', content: JSON.stringify({
      query: '[evaluation:skill-technical] 新建技术文章',
      skill_snapshot: { skill: { skill_id: 'builtin-technical-article', name: '技术文章' } },
      dependency_evidence: [{ citation: { id: 'source-1' }, content: 'Orion 负责人陈青，回滚48小时。const retry = 3;' }],
    }) }], [{ type: 'function', function: { name: 'propose_new_document', description: '', parameters: {} } }]);
    expect(response.message.tool_calls?.[0]?.function.name).toBe('propose_new_document');
    const proposal = JSON.parse(response.message.tool_calls![0]!.function.arguments);
    expect(proposal.markdown).toContain('```ts\nconst retry = 3;\n```');
    expect(proposal.citation_ids).toEqual(['source-1']);
  });
});

describe('controlled preference extraction and task defaults', () => {
  const extract = async (input: string, previous: unknown[] = []) => {
    const result = await businessModel([{ role: 'user', content: JSON.stringify({ purpose: 'writing_preferences', input, previous }) }]);
    return JSON.parse(result.message.content!);
  };

  test('distinguishes explicit saving from candidates and temporary task requirements', async () => {
    expect(await extract('请记住我的长期写作偏好：默认使用简洁技术文风。')).toEqual({
      save: [{ text: '默认使用简洁技术文风', quote: '默认使用简洁技术文风' }], candidates: [],
    });
    expect(await extract('刚才的表达太口语化，以后我更喜欢正式技术文风。')).toEqual({
      save: [], candidates: [{ text: '默认使用正式技术文风', quote: '以后我更喜欢正式技术文风' }],
    });
    expect(await extract('本次请详细说明，当前任务完成即可。')).toEqual({ save: [], candidates: [] });
  });

  test('binds conflict candidates to confirmed preferences for later user choice', async () => {
    expect(await extract('以后我更喜欢详细技术文风。', [
      { id: 'short', status: 'confirmed', text: '默认使用简洁技术文风' },
      { id: 'pending', status: 'pending', text: '候选' },
    ])).toMatchObject({ save: [], candidates: [{ conflicts_with: ['short'] }] });
  });

  test('a current detailed request overrides the scripted concise default', async () => {
    const response = await businessModel([{ role: 'user', content: JSON.stringify({
      query: '[evaluation:pref-current-request] 本次请详细说明',
      user_preferences: { revision: 1, items: [{ id: 'short', text: '默认使用简洁技术文风' }] },
    }) }]);
    const result = JSON.parse(response.message.tool_calls![0]!.function.arguments);
    expect(result.answer).toContain('本次按详细要求');
    expect(result.citation_ids).toEqual([]);
  });
});

describe('controlled context continuation', () => {
  const tool = (name: string) => ({ type: 'function' as const, function: { name, description: '', parameters: {} } });

  test('compaction returns unresolved state and directs exact work back to original evidence', async () => {
    const response = await businessModel([{ role: 'user', content: JSON.stringify({
      purpose: 'task_context_compaction', goal: '核对回滚和代码', data: { content: '原始长资料' },
    }) }]);
    expect(JSON.parse(response.message.content!)).toMatchObject({
      summary: expect.stringContaining('read_task_evidence'), missing: ['回取原文核对回滚窗口和重试代码'], conflicts: [],
    });
  });

  test('a compacted source produces a real retrieval invocation using its server handle', async () => {
    const response = await businessModel([
      { role: 'user', content: JSON.stringify({ query: '[evaluation:context-compaction-retrieval] 核对原文', references: [] }) },
      { role: 'tool', tool_call_id: 'read', content: JSON.stringify({ compacted: true, summary: '摘要',
        evidence_references: [{ citation_id: 'source-page', read_tool: 'read_task_evidence' }], missing: [], conflicts: [] }) },
    ], [tool('read_task_evidence')]);
    expect(response.message.tool_calls?.[0]?.function).toMatchObject({ name: 'read_task_evidence' });
    expect(JSON.parse(response.message.tool_calls![0]!.function.arguments)).toEqual({ citation_id: 'source-page', offset: 0, limit: 512 });
  });

  test('unknown-citation fixture exercises an actual forbidden retrieval attempt', async () => {
    const response = await businessModel([{ role: 'user', content: JSON.stringify({
      query: '[evaluation:context-unknown-citation] 检查未知证据',
      dependency_evidence_catalog: [{ citation_id: 'observed-source' }],
    }) }], [tool('read_task_evidence')]);
    expect(JSON.parse(response.message.tool_calls![0]!.function.arguments).citation_id).toBe('unobserved-other-task-citation');
  });

  test('a current-document dependency handle is preferred for the edit-read boundary', async () => {
    const response = await businessModel([{ role: 'user', content: JSON.stringify({
      query: '[evaluation:context-edit-read-proof] 改写选区',
      dependency_evidence_catalog: [{ citation_id: 'reference-1' }, { citation_id: 'current-snapshot-selection' }],
    }) }], [tool('read_task_evidence')]);
    expect(JSON.parse(response.message.tool_calls![0]!.function.arguments).citation_id).toBe('current-snapshot-selection');
  });
});
