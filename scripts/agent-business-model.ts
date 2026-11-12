import { randomUUID } from 'node:crypto';
import type { AgentMessage, FunctionTool } from '../src/ai/document-agent.types.js';
import { supervisorResponse } from '../tests/fixtures/supervisor-response.js';
import { handoffArguments } from '../tests/fixtures/worker-handoff.js';
import { researchBusinessModel, resetResearchBusinessModel } from './research-business-model.js';

const plain = (value: unknown) => ({
  message: { role: 'assistant' as const, content: JSON.stringify(value) },
  usage: { prompt_tokens: 20, completion_tokens: 10 },
});
function call(name: string, args: unknown) {
  return { message: { role: 'assistant' as const, content: null, tool_calls: [{
    id: randomUUID(), type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }] }, usage: { prompt_tokens: 40, completion_tokens: 20 } };
}

const verificationFailures = new Set<string>();
const primaryCompletions = new Map<string, number>();
export function resetBusinessModelState() {
  resetResearchBusinessModel();
  verificationFailures.clear();
  primaryCompletions.clear();
}

function verificationResponse(payload: any) {
  if (!['evidence_verification', 'evidence_repair'].includes(payload.purpose)) return;
  const input = payload.input ?? payload;
  const query = String(input.request?.query ?? input.query ?? '');
  const scenario = query.match(/\[evaluation:(verify-[a-z-]+)\]/)?.[1] ?? '';
  const candidate = input.candidate;
  const edit = candidate?.kind === 'edits' ? candidate.edits[0] : undefined;
  const text = String(candidate?.answer ?? candidate?.markdown ?? edit?.content_markdown ?? '');
  const adoptedIds: string[] = candidate?.citation_ids ?? edit?.citation_ids ?? [];
  const citationIds: string[] = edit && !adoptedIds.length
    ? (input.evidence ?? []).filter((row: any) => row.citation?.kind === 'current_document')
      .map((row: any) => row.id)
    : adoptedIds;
  if (payload.purpose === 'evidence_repair') {
    const content = scenario === 'verify-unsupported'
      ? 'Orion 项目的负责人为陈青。预算未记录。'
      : `Orion 项目的回滚窗口为${scenario === 'verify-recheck' ? '96' : '48'}小时。`;
    const answer = content + citationIds.map((id) => ` [${id}]`).join('');
    return plain(candidate.kind === 'answer' ? { ...candidate, answer } : candidate.kind === 'document'
      ? { ...candidate, markdown: answer }
      : { ...candidate, edits: candidate.edits.map((item: any, index: number) => index ? item : { ...item, content_markdown: answer }) });
  }
  if (scenario === 'verify-error-interrupted' && !verificationFailures.has(query)) {
    verificationFailures.add(query);
    throw new Error('CONTROLLED_VERIFICATION_UNAVAILABLE');
  }
  const incorrect = /999万元|72小时|96小时/.test(text);
  const rerun = scenario === 'verify-local-rerun' && incorrect;
  const segments: Array<{ location: Record<string, unknown>; text: string; inline_citation_required?: boolean }> = input.segments?.length
    ? input.segments
    : [{ location: { field: candidate.kind === 'answer' ? 'answer' : candidate.kind === 'document' ? 'markdown' : 'edit',
      ...(edit ? { edit_id: edit.id } : {}), start: 0, end: text.length }, text }];
  const claims = segments.map((segment, index) => {
    const unsupported = /999万元|72小时|96小时/.test(segment.text);
    const inlineIds = citationIds.filter((id) => segment.text.includes(`[${id}]`));
    return { id: index ? `claim-orion-${index + 1}` : 'claim-orion', location: segment.location,
      text: segment.text, citation_ids: inlineIds.length ? inlineIds : citationIds,
      step_ids: rerun && unsupported ? ['read_window'] : [], status: unsupported ? 'unsupported' : 'supported',
      reason: unsupported ? '原文只支持回滚48小时，预算未记载，当前数字缺乏依据。' : '结论与已读取的原文一致。' };
  });
  return plain({
    candidate_version: input.candidate_version,
    passed: !incorrect,
    claims,
    recovery: { action: incorrect ? rerun ? 'rerun' : 'repair' : 'none',
      claim_ids: claims.filter((claim) => claim.status !== 'supported').map((claim) => claim.id), step_ids: rerun ? ['read_window'] : [],
      instruction: incorrect ? '保留已确认负责人，依据原文核实回滚窗口，未记载的预算明确保留缺口。' : '' },
  });
}

/** Scripted responses exercise HTTP orchestration; their quality is not a model benchmark. */
export async function businessModel(messages: AgentMessage[], tools: FunctionTool[] = [], _signal?: AbortSignal, options?: any): Promise<{ message: AgentMessage; usage: { prompt_tokens: number; completion_tokens: number } }> {
  const payload = JSON.parse(messages.find((message) => message.role === 'user')?.content ?? '{}');
  const researchResponse = researchBusinessModel(payload, messages, tools);
  if (researchResponse) return researchResponse;
  const verified = verificationResponse(payload);
  if (verified) return verified;
  if (payload.purpose === 'task_context_compaction') return plain({
    summary: '已压缩 Orion 资料。准确数字、代码及引用位置须通过 read_task_evidence 回取原文核对。',
    missing: ['回取原文核对回滚窗口和重试代码'], conflicts: [],
  });
  if (payload.purpose === 'writing_preferences') {
    const text = String(payload.input ?? '');
    if (text.includes('请记住我的长期写作偏好：默认使用简洁技术文风。'))
      return plain({ save: [{ text: '默认使用简洁技术文风', quote: '默认使用简洁技术文风' }], candidates: [] });
    if (text.includes('以后我更喜欢正式技术文风'))
      return plain({ save: [], candidates: [{ text: '默认使用正式技术文风', quote: '以后我更喜欢正式技术文风' }] });
    if (text.includes('以后我更喜欢详细技术文风'))
      return plain({ save: [], candidates: [{ text: '默认使用详细技术文风', quote: '以后我更喜欢详细技术文风',
        conflicts_with: (payload.previous ?? []).filter((item: any) => item.status === 'confirmed').map((item: any) => item.id) }] });
    return plain({ save: [], candidates: [] });
  }
  if (payload.purpose === 'conversation_constraints') {
    const text: string = payload.input;
    if (text === '接下来始终保留代码块') return plain({
      upsert: [{ kind: 'constraint', text, quote: text }], remove: [],
    });
    if (text === '取消之前保留代码块的要求，后续允许修改代码块') return plain({
      upsert: [{ id: payload.previous[0].id, kind: 'constraint', text: '后续允许修改代码块', quote: '后续允许修改代码块' }], remove: [],
    });
    return plain({ upsert: [], remove: [] });
  }
  const supervisor = supervisorResponse(messages);
  if (supervisor) return supervisor;
  if (options?.role === 'classifier') return plain({
    strategy: String(payload.query).includes('[evaluation:verify-local-rerun]') ? 'plan_execute' : 'react',
    reason: 'controlled business task', needs_knowledge: Boolean(payload.knowledge_scope_selected),
    ...(String(payload.query).includes('[evaluation:skill-suggestions]') ? { skill_suggestions: ['builtin-technical-article'] } : {}),
  });
  if (options?.role === 'critic') return plain({ passed: true, issues: [] });
  if (options?.role === 'plan' && String(payload.query).includes('[evaluation:verify-local-rerun]')) return plain({
    goal: '根据当前资料总结 Orion 项目的负责人及回滚窗口', outline: [], constraints: [],
    steps: [
      { id: 'read_owner', capability: 'read', description: '读取负责人资料', depends_on: [] },
      { id: 'read_window', capability: 'read', description: '读取回滚窗口资料', depends_on: ['read_owner'] },
      { id: 'combine', capability: 'compose', description: '总结已读取的负责人及回滚窗口证据', depends_on: ['read_owner', 'read_window'] },
    ],
  });
  if (options?.role === 'plan' && String(payload.query).includes('[evaluation:context-')) return plain({
    goal: payload.query, outline: [], constraints: ['保持数字、代码和引用准确'],
    steps: [
      { id: 'read_long_sources', capability: 'read', description: '逐份读取三份长参考资料，压缩后保留证据标识。', depends_on: [] },
      ...(String(payload.query).includes('[evaluation:context-edit-read-proof]') ? [
        { id: 'read_selection', capability: 'read', description: '亲自读取当前精确选区并交接事实证据。', depends_on: ['read_long_sources'] },
      ] : []),
    ],
  });
  if (options?.role === 'plan') return plain({
    goal: payload.query ?? '改写当前选区', outline: [], constraints: [],
    steps: [
      { id: 'read', capability: 'read', description: '读取当前选区', depends_on: [] },
      ...(String(payload.query).includes('总结证据') ? [
        { id: 'combine', capability: 'compose', description: '总结已读资料', depends_on: ['read'] },
      ] : []),
    ],
  });
  const available = (name: string) => tools.some((tool) => tool.function.name === name);
  const skillCase = String(payload.query).includes('[evaluation:skill-');
  const preferenceCase = String(payload.query).includes('[evaluation:pref-');
  const contextCase = String(payload.query).includes('[evaluation:context-');
  const outputs = messages.filter((message) => message.role === 'tool').map((message) => {
    try { return JSON.parse(message.content ?? '{}'); } catch { return {}; }
  });
  const evidence: Array<{ id: string; content: string }> = (payload.dependency_evidence ?? [])
    .map((row: any) => ({ id: row.citation.id, content: row.content }));
  for (const output of outputs) {
    for (const row of Array.isArray(output) ? output : [output, ...(output.sources ?? [])]) {
      if (row.citation_id) evidence.push({ id: row.citation_id,
        content: row.content ?? row.selected_text ?? row.regions?.map((region: any) => region.markdown ?? region.text).join('\n') ?? '已读取原文' });
    }
  }
  const invocations = messages.flatMap((message) => message.tool_calls ?? []);
  if (contextCase) {
    const retrieved = invocations.some((invocation) => invocation.function.name === 'read_task_evidence');
    const compacted = outputs.filter((output) => output.compacted);
    const handles: Array<{ citation_id: string }> = [
      ...(payload.dependency_evidence_catalog ?? []),
      ...compacted.flatMap((output) => output.evidence_references ?? []),
    ];
    if (payload.step?.id === 'read_selection' && !invocations.some((invocation) => invocation.function.name === 'read_current_document'))
      return call('read_current_document', { region_ids: [], selection: true });
    const readIds = invocations.filter((invocation) => invocation.function.name === 'read_reference')
      .map((invocation) => JSON.parse(invocation.function.arguments).reference_id);
    const reference = payload.references?.find((item: any) => !readIds.includes(item.id));
    if (payload.step?.id !== 'read_selection' && reference && available('read_reference') &&
      (payload.step || !payload.dependency_evidence?.length && !payload.dependency_evidence_catalog?.length))
      return call('read_reference', { reference_id: reference.id, offset: 0, limit: 16000 });
    if (!payload.step && !retrieved && available('read_task_evidence') && handles.length)
      return call('read_task_evidence', { citation_id: String(payload.query).includes('[evaluation:context-unknown-citation]')
        ? 'unobserved-other-task-citation' : String(payload.query).includes('[evaluation:context-edit-read-proof]')
          ? handles.find((handle) => handle.citation_id.startsWith('current-'))?.citation_id ?? handles[0]!.citation_id
          : handles[0]!.citation_id, offset: 0, limit: 512 });
    if (!payload.step && String(payload.query).includes('[evaluation:context-edit-read-proof]')) {
      const ownRead = invocations.some((invocation) => invocation.function.name === 'read_current_document');
      const rejectedEdit = outputs.some((output) => typeof output.error === 'string' && /选区|读取|区域/.test(output.error));
      if (rejectedEdit && !ownRead && available('read_current_document'))
        return call('read_current_document', { region_ids: [], selection: true });
      return call('propose_document_edits', { edits: [{ id: 'context-selection', operation: 'replace',
        target: { kind: 'selection' }, content_markdown: 'Orion 的负责人为陈青，发布后48小时内可以回滚。',
        explanation: '核对原文后改善表达', citation_ids: [] }] });
    }
    if (payload.step || retrieved) {
      const id = payload.step?.id === 'read_selection' ? evidence.find((item) => item.id.startsWith('current-'))?.id : evidence[0]?.id;
      const body = payload.step?.id === 'read_selection' ? 'Orion 负责人为陈青，回滚窗口为48小时。' : 'Orion 回滚窗口为48小时，重试代码为 const retry = 3;。';
      const args = { answer: body + (id ? ` [${id}]` : ''),
        citation_ids: id ? [id] : [] };
      return call('finish_answer', payload.step ? handoffArguments(args) : args);
    }
  }
  if (preferenceCase && !payload.step && !String(payload.query).includes('[evaluation:pref-snapshot-restart]')) {
    const preferences = (payload.user_preferences?.items ?? []).map((item: any) => item.text);
    const answer = String(payload.query).includes('本次请详细说明')
      ? '本次按详细要求说明。当前长期偏好仍为简洁技术文风。本次要求优先于长期默认写法。'
      : preferences.length ? `当前长期写作偏好为${preferences.join('、')}。`
        : '当前没有已确认的长期写作偏好。';
    return call('finish_answer', { answer, citation_ids: [] });
  }
  if (skillCase && String(payload.query).includes('[evaluation:skill-permission]') &&
    payload.step?.id === 'read_record' && !invocations.some((invocation) => invocation.function.name === 'search_web'))
    return call('search_web', { query: '这是不应执行的联网请求' });
  if (payload.skill_snapshot && payload.step?.capability === 'read' && available('read_reference')) {
    const readIds = invocations.filter((invocation) => invocation.function.name === 'read_reference')
      .map((invocation) => JSON.parse(invocation.function.arguments).reference_id);
    const reference = payload.references?.find((item: any) => !readIds.includes(item.id));
    if (reference) return call('read_reference', { reference_id: reference.id });
  }
  if (available('search_web') && !outputs.length)
    return call('search_web', { query: payload.query });
  if (available('search_knowledge_base') && !outputs.length)
    return call('search_knowledge_base', { query: payload.query });
  if (available('read_current_document') && (!outputs.length || (skillCase && !evidence.length)) &&
    (!payload.dependency_evidence?.length || available('propose_document_edits')))
    return call('read_current_document', { region_ids: [], selection: true });
  if (payload.skill_snapshot && !payload.step && available('propose_new_document')) {
    const ids = [...new Set(evidence.map((item) => item.id))];
    const cite = ids.map((id) => `[${id}]`).join(' ');
    const skillId = payload.skill_snapshot.skill.skill_id;
    let markdown = `# 会议纪要\n\n会议决定由陈青整理 Orion 发布资料。${cite}\n\n## 行动项\n\n| 事项 | 负责人 | 截止日期 |\n| --- | --- | --- |\n| 整理发布资料 | 陈青 | 待确认 |`;
    if (skillId === 'builtin-technical-article') markdown = `# 技术文章\n\nOrion 的负责人为陈青，回滚窗口为48小时。${cite}\n\n## 代码示例\n\n\`\`\`ts\nconst retry = 3;\n\`\`\`\n\n以上代码来自已选资料。${cite}`;
    if (skillId === 'builtin-source-comparison') markdown = `# 资料对比\n\n方案甲与方案乙的预算存在冲突，按各自资料分别列出。${cite}\n\n| 对比维度 | 方案甲 | 方案乙 |\n| --- | --- | --- |\n| 预算 | 120万元 | 180万元 |\n| 回滚窗口 | 48小时 | 48小时 |`;
    return call('propose_new_document', { title: payload.skill_snapshot.skill.name, markdown, citation_ids: ids });
  }
  if (available('propose_document_edits') && /改写|润色/.test(payload.query) && !payload.step)
    return call('propose_document_edits', { edits: [{ id: 'business-edit', operation: 'replace',
      target: { kind: 'selection' }, content_markdown: '本项目支持文档编辑与知识检索。',
      explanation: '保留原意，改善表达', citation_ids: [] }] });
  const ids = [...new Set(evidence.map((row) => row.id))];
  let answer = /当前有效的持续写作要求/.test(payload.query)
    ? (payload.conversation_constraints?.items ?? []).map((item: any) => item.text).join('；') || '当前没有持续要求'
    : evidence.length ? evidence.map((row) => `${row.content} [${row.id}]`).join('\n') +
    (/预算/.test(payload.query) ? '\n预算资料存在冲突或尚未记录，按原文分别列出。' : '')
    : '已记录本轮要求。';
  if (preferenceCase && !payload.step && String(payload.query).includes('[evaluation:pref-snapshot-restart]')) {
    const preferences = (payload.user_preferences?.items ?? []).map((item: any) => item.text).join('、');
    answer = `当前任务采用${preferences || '默认写作方式'}。` + answer;
  }
  if (!payload.step && String(payload.query).includes('[evaluation:verify-')) {
    const scenario = String(payload.query).match(/\[evaluation:(verify-[a-z-]+)\]/)?.[1] ?? '';
    const count = primaryCompletions.get(scenario) ?? 0;
    primaryCompletions.set(scenario, count + 1);
    if (scenario === 'verify-unsupported') answer = `Orion 项目的负责人为陈青。预算为999万元。 ${ids.map((id) => `[${id}]`).join(' ')}`;
    if (['verify-repaired', 'verify-recheck'].includes(scenario) || (scenario === 'verify-local-rerun' && !count))
      answer = `Orion 项目的负责人为陈青，回滚窗口为72小时。 ${ids.map((id) => `[${id}]`).join(' ')}`;
  }
  const args = { answer, citation_ids: ids };
  return call('finish_answer', payload.step ? handoffArguments(args) : args);
}
