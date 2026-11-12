import { randomUUID } from 'node:crypto';
import type { AgentMessage, FunctionTool } from '../src/ai/document-agent.types.js';
import { handoffArguments } from '../tests/fixtures/worker-handoff.js';
const failures = new Set<string>();
const completions = new Map<string, number>();
export const resetResearchBusinessModel = () => { failures.clear(); completions.clear(); };
const plain = (value: unknown) => ({ message: { role: 'assistant' as const, content: JSON.stringify(value) }, usage: { prompt_tokens: 20, completion_tokens: 10 } });
const call = (name: string, args: unknown) => ({ message: { role: 'assistant' as const, content: null, tool_calls: [{ id: randomUUID(),
  type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] }, usage: { prompt_tokens: 30, completion_tokens: 10 } });

/** Controlled fixture responses exercise the production graph, not semantic quality. */
export function researchBusinessModel(payload: any, messages: AgentMessage[], tools: FunctionTool[]) {
  const query = String(payload.query ?? payload.brief?.goal ?? '');
  if (payload.purpose === 'research_brief') {
    const missing = query.includes('research-missing'), chapters = query.includes('research-chapters');
    const questions = [{ id: 'q1', text: '谁是项目负责人', section_ids: chapters ? ['s1', 's2'] : ['s1'] },
      { id: 'q2', text: '回滚窗口是多久', section_ids: chapters ? ['s3', 's4'] : ['s2'] },
      ...(missing ? [{ id: 'q3', text: '实际案例', section_ids: ['s3'] }] : [])];
    return plain({ goal: query, audience: '后端开发者', deliverable: '研究文章', constraints: [], unknowns: [], preferred_sources: ['所选资料'], questions,
      sections: chapters ? [
        { id: 's1', title: '项目背景', question_ids: ['q1'] }, { id: 's2', title: '负责人', question_ids: ['q1'] },
        { id: 's3', title: '回滚规则', question_ids: ['q2'] }, { id: 's4', title: '资料边界', question_ids: ['q2'] },
      ] : [{ id: 's1', title: '负责人', question_ids: ['q1'] }, { id: 's2', title: '回滚规则', question_ids: ['q2'] },
        ...(missing ? [{ id: 's3', title: '实际案例', question_ids: ['q3'] }] : [])] });
  }
  if (payload.purpose === 'research_coverage') {
    if (query.includes('research-review-error') && !failures.has(query)) { failures.add(query); throw new Error('CONTROLLED_RESEARCH_COVERAGE_UNAVAILABLE'); }
    const candidate = payload.candidate;
    const text = candidate.markdown ?? candidate.answer ?? '';
    const missingWindow = !text.includes('48');
    return plain({ candidate_version: payload.candidate_version, items: payload.brief.questions.map((q: any) => ({
      question_id: q.id, status: q.id === 'q3' ? 'missing' : q.id === 'q2' && missingWindow ? 'missing' : 'covered',
      locations: q.id === 'q2' && missingWindow ? [] : [{ field: candidate.kind === 'document' ? 'markdown' : 'answer', start: 0, end: text.length }],
      citation_ids: candidate.citation_ids ?? [], reason: q.id === 'q3' ? '已明确说明资料未记录案例' : '根据原文核对必答问题',
      gap_declared: q.id === 'q3' && text.includes('未记录'),
    })), recovery: { action: missingWindow ? query.includes('research-supplement') && payload.can_research ? 'research' : 'repair' : 'none',
      instruction: missingWindow ? '补全回滚窗口这一必答问题，核实原文的48小时。' : '' } });
  }
  if (payload.purpose === 'research_repair') {
    const ids = payload.evidence.map((e: any) => e.id);
    return plain({ ...payload.candidate, markdown: `# Orion 研究文章\n\n负责人为陈青，回滚窗口为48小时。${ids.map((id: string) => `[${id}]`).join(' ')}\n\n资料未记录实际案例。${ids.map((id: string) => `[${id}]`).join(' ')}`, citation_ids: ids });
  }
  if (payload.purpose === 'research_section') {
    const ids = payload.evidence.map((e: any) => e.id);
    return plain({ markdown: `## ${payload.section.title}\n\n负责人为陈青，回滚窗口为48小时。${ids.map((id: string) => `[${id}]`).join(' ')}`, citation_ids: ids });
  }
  if (payload.purpose === 'research_integrate') return plain({ title: 'Orion 研究文章', markdown: `# Orion 研究文章\n\n${payload.chapters.map((c: any) => c.markdown).join('\n\n')}`,
    citation_ids: [...new Set(payload.chapters.flatMap((c: any) => c.citation_ids))] });
  if (payload.purpose || payload.skill_snapshot?.skill.workflow !== 'research_writing') return;
  const available = (name: string) => tools.some(t => t.function.name === name);
  const invocations = messages.flatMap(m => m.tool_calls ?? []);
  const outputs = messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content ?? '{}'); } catch { return {}; } });
  const evidence = (payload.dependency_evidence ?? []).map((e: any) => ({ id: e.citation.id, content: e.content }));
  for (const output of outputs) for (const item of Array.isArray(output) ? output : [output, ...(output.sources ?? [])]) {
    if (item.citation_id) evidence.push({ id: item.citation_id, content: item.content ?? item.regions?.map((r: any) => r.text).join('\n') ?? '' });
  }
  const ids: string[] = [...new Set<string>(evidence.map((e: any) => e.id))];
  if (payload.step?.capability === 'read' && available('read_reference') && !invocations.length)
    return call('read_reference', { reference_id: payload.references[0].id });
  if (payload.step?.capability === 'search' && available('search_knowledge_base')) {
    const count = invocations.filter(c => c.function.name === 'search_knowledge_base').length;
    if (count < 2) return call('search_knowledge_base', { query: count ? 'Orion 回滚窗口 48小时' : 'Orion 负责人 陈青',
      question_id: count ? 'q2' : 'q1', gap_reason: count ? '还需核实回滚窗口' : '核实项目负责人', original_only: true });
  }
  if (payload.step) return call('finish_answer', { ...handoffArguments({ answer: `负责人陈青，回滚窗口48小时。${ids.map(id => `[${id}]`).join(' ')}`, citation_ids: ids }),
    research_notes: payload.research_brief.questions.map((q: any) => ({ question_id: q.id,
      findings: q.id === 'q3' || !ids.length ? [] : [{ statement: q.id === 'q1' ? '负责人陈青' : '回滚窗口48小时', evidence_ids: ids }],
      missing: q.id === 'q3' || !ids.length ? ['资料未记录实际案例'] : [], conflicts: [] })) });
  const count = completions.get(query) ?? 0; completions.set(query, count + 1);
  const incomplete = /research-(repair|supplement)/u.test(query) && !count;
  const cite = ids.map(id => `[${id}]`).join(' ');
  return call('propose_new_document', { title: 'Orion 研究文章', markdown: `# Orion 研究文章\n\n负责人为陈青${incomplete ? '' : '，回滚窗口为48小时'}。${cite}${query.includes('research-missing') ? `\n\n资料未记录实际案例。${cite}` : ''}`, citation_ids: ids });
}
