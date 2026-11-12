import { describe, expect, jest, test } from '@jest/globals';
import { ResearchWritingService } from '../src/ai/research-writing.service.js';
import { validateBrief, validateResearchNotes, validateResearchReview, emptyResearchProgress, researchSearchStart, researchSearchEnd, sourceExcerpts } from '../src/ai/research-writing.js';
import { RESEARCH_POLICY, V2_POLICY, supportedPolicy } from '../src/ai/graph/graph-policy.js';
import { emptyUsage, type WorkerOutput } from '../src/ai/agent-runtime.types.js';
import { BUILTIN_WRITING_SKILLS } from '../src/ai/writing-skills.service.js';
import { request } from './fixtures/agent-request.js';
import { EvidenceVerificationService } from '../src/ai/evidence-verification.service.js';

export const brief = { goal: '解释原理和限制', audience: '开发者', deliverable: '技术文章', constraints: [], unknowns: [], preferred_sources: [],
  questions: [{ id: 'q1', text: '原理', section_ids: ['s1'] }, { id: 'q2', text: '限制', section_ids: ['s2'] }],
  sections: [{ id: 's1', title: '原理', question_ids: ['q1'] }, { id: 's2', title: '限制', question_ids: ['q2'] }] };
const candidate: WorkerOutput = { result: { kind: 'document', document_id: 'candidate', title: '文章', markdown: '原理说明 [e1]\n\n限制缺少资料。 [e1]', citation_ids: ['e1'] },
  citations: [{ id: 'e1', kind: 'text', title: '来源' }], evidence: [['e1', '原理说明，未记录限制']], observations: [{ citation_id: 'e1', content: '原理说明，未记录限制' }],
  read_region_ids: [], selection_read: false, usage: emptyUsage() };
const coverage = () => ({ candidate_version: 0, items: [
  { question_id: 'q1', status: 'covered', locations: [{ field: 'markdown', start: 0, end: 10 }], citation_ids: ['e1'], reason: '回答了原理', gap_declared: false },
  { question_id: 'q2', status: 'missing', locations: [{ field: 'markdown', start: 12, end: 20 }], citation_ids: ['e1'], reason: '已明确说明资料不足', gap_declared: true },
], recovery: { action: 'none', instruction: '' } });

describe('research writing boundaries', () => {
  test('long final drafts verify every paragraph in bounded batches and merge unique claim identities', async () => {
    const markdown = Array.from({ length: 6 }, () => `${'原理、条件与限制保持原意。'.repeat(80)} [e1]`).join('\n\n');
    let calls = 0;
    const result = await new EvidenceVerificationService().verify({ candidate: { kind: 'document', document_id: 'doc', title: '长文', markdown, citation_ids: ['e1'] },
      candidate_version: 2, request: request('agent'), evidence: [['e1', '原理、条件与限制保持原意。']], citations: candidate.citations, batch_chars: 2400 },
      async messages => {
        calls++;
        const input = JSON.parse(messages[1]!.content!);
        expect(input.segments.reduce((total: number, segment: any) => total + segment.text.length, 0)).toBeLessThanOrEqual(2400);
        return { role: 'assistant', content: JSON.stringify({ candidate_version: 2,
          claims: input.segments.map((segment: any, index: number) => ({ id: `claim${index}`, location: segment.location, text: segment.text,
            citation_ids: ['e1'], step_ids: [], status: 'supported', reason: '原文支持' })),
          recovery: { action: 'none', claim_ids: [], step_ids: [], instruction: '' } }) };
      });
    expect(calls).toBeGreaterThan(1); expect(result.passed).toBe(true);
    expect(result.claims).toHaveLength(6); expect(new Set(result.claims.map(c => c.id)).size).toBe(6);
    expect(result.claims.every(c => markdown.slice(c.location.start, c.location.end) === c.text)).toBe(true);
  });
  test('retains standard policy and rejects altered saved policies', () => {
    expect(supportedPolicy(V2_POLICY)).toBe(true); expect(supportedPolicy(RESEARCH_POLICY)).toBe(true);
    expect(supportedPolicy({ ...RESEARCH_POLICY, search_limit: 300 })).toBe(false);
    expect(BUILTIN_WRITING_SKILLS.find(s => s.workflow === 'research_writing')?.steps).toHaveLength(2);
  });
  test('validates both directions of question-to-section mapping', () => {
    expect(validateBrief(brief)).toEqual(brief);
    expect(() => validateBrief({ ...brief, sections: [{ id: 's1', title: '标题', question_ids: ['unknown'] }] })).toThrow();
  });
  test('permits one changed query after empty results, stops after two empty attempts', () => {
    const progress = emptyResearchProgress();
    researchSearchStart(progress, 'search_knowledge_base', { query: '原理', question_id: 'q1', gap_reason: '寻找原理' }, brief);
    researchSearchEnd(progress, [], new Map()); expect(progress.stop_reason).toBeUndefined();
    researchSearchStart(progress, 'search_knowledge_base', { query: '工作机制', question_id: 'q1', gap_reason: '首次无结果换关键词' }, brief);
    researchSearchEnd(progress, [], new Map()); expect(progress.stop_reason).toBe('no_new_evidence');
    expect(() => researchSearchStart(progress, 'search_knowledge_base', { query: '第三次' }, brief)).toThrow();
  });
  test('deduplicates stable evidence despite different tool-call citation IDs and caps searches', () => {
    const progress = emptyResearchProgress();
    for (let index = 0; index < 3; index++) {
      researchSearchStart(progress, 'search_web', { query: `query${index}`, question_id: 'q1', gap_reason: '核实原理' }, brief);
      const id = `call${index}`;
      researchSearchEnd(progress, [{ citation_id: id, content: '同一段原文' }], new Map([[id, { id, kind: 'web', title: '来源', url: 'https://example.com/a' }]]));
    }
    expect(progress.evidence_hashes).toHaveLength(1); expect(progress.searches).toBe(3);
    expect(() => researchSearchStart(progress, 'search_web', { query: 'fourth', question_id: 'q1', gap_reason: '继续' }, brief)).toThrow();
  });
  test('rejects repeated normalized queries and unbound questions', () => {
    const progress = emptyResearchProgress();
    expect(() => researchSearchStart(progress, 'search_web', { query: 'test' }, brief)).toThrow();
    researchSearchStart(progress, 'search_web', { query: ' TEST ', question_id: 'q1', gap_reason: '检索' }, brief);
    expect(() => researchSearchStart(progress, 'search_web', { query: 'test', question_id: 'q1', gap_reason: '重复' }, brief)).toThrow();
    expect(progress.stop_reason).toBe('repeated_query');
  });
  test('finds web evidence after the previous 5000-character cutoff and preserves offsets', () => {
    const text = '背景内容。'.repeat(1700) + 'React concurrency 的限制是不能中断同步代码。';
    const excerpts = sourceExcerpts(text, 'concurrency 限制', 2000);
    expect(excerpts.some(e => e.text.includes('不能中断同步代码'))).toBe(true);
    expect(excerpts.every(e => text.slice(e.start, e.end) === e.text)).toBe(true);
  });
  test('keeps more than six findings in notes, but rejects another worker citation', () => {
    const notes = [{ question_id: 'q1', findings: Array.from({ length: 9 }, (_, i) => ({ statement: `发现${i}`, evidence_ids: ['e1'] })), missing: [], conflicts: [] }];
    expect(validateResearchNotes(notes, brief, ['e1'], candidate.observations)[0]?.findings).toHaveLength(9);
    expect(() => validateResearchNotes(notes, brief, [], candidate.observations)).toThrow();
  });
  test('distinguishes declared evidence gaps from complete coverage and validates candidate version and positions', () => {
    expect(validateResearchReview(coverage(), brief, candidate.result, 0, ['e1'])).toMatchObject({ deliverable: true, completeness: 'partial' });
    const missing = coverage(); missing.items[1]!.gap_declared = false;
    expect(() => validateResearchReview(missing, brief, candidate.result, 0, ['e1'])).toThrow();
    expect(() => validateResearchReview(coverage(), brief, candidate.result, 1, ['e1'])).toThrow();
    const stale = coverage(); stale.items[0]!.locations[0]!.end = 9999;
    expect(() => validateResearchReview(stale, brief, candidate.result, 0, ['e1'])).toThrow();
    const omitted = coverage(); omitted.items.pop();
    expect(() => validateResearchReview(omitted, brief, candidate.result, 0, ['e1'])).toThrow();
  });
  test('coverage service propagates technical failures and repairs preserve targets', async () => {
    const service = new ResearchWritingService();
    await expect(service.review(brief, candidate, {}, 0, true, async () => { throw new Error('offline'); })).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });
    await expect(service.repair(request('agent'), brief, candidate, {}, async () => ({ role: 'assistant', content: JSON.stringify({ ...candidate.result, document_id: 'other' }) })))
      .rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });
  });
  test('restores completed chapters without regenerating them, then integrates and validates citations', async () => {
    const longBrief = { ...brief, sections: [...brief.sections, { id: 's3', title: '应用', question_ids: ['q1'] }, { id: 's4', title: '注意', question_ids: ['q2'] }] };
    const artifacts = new Map<string, any>();
    const turn = jest.fn<any>(async (messages: any[]) => {
      const payload = JSON.parse(messages[1].content);
      return { role: 'assistant', content: JSON.stringify({ markdown: payload.purpose === 'research_integrate' ? '原理说明 [e1]' : `## ${payload.section.title}\n\n原理说明 [e1]`, citation_ids: ['e1'] }) };
    });
    const input = { request: { ...request('agent'), output_target: 'new_document' as const, editor_snapshot: { ...request('agent').editor_snapshot,
      selection: { ...request('agent').editor_snapshot.selection, text: '' } } },
      skill: { skill: BUILTIN_WRITING_SKILLS[0]!, inputs: {} }, brief: longBrief, candidate, turn,
      load: async (key: string) => artifacts.get(key), save: async (key: string, value: unknown) => { artifacts.set(key, value); }, emit: () => {}, signal: new AbortController().signal };
    await new ResearchWritingService().chapters(input); expect(turn).toHaveBeenCalledTimes(5);
    await new ResearchWritingService().chapters(input); expect(turn).toHaveBeenCalledTimes(6);
  });
  test('chapter integration for current-document writing preserves the original edit targets', async () => {
    const draft: WorkerOutput = { ...candidate, result: { kind: 'edits', edits: [{ id: 'edit', operation: 'replace',
      target: { kind: 'block_range', first_region_id: 'b0' }, content_markdown: '旧候选', explanation: '改写', citation_ids: ['e1'] }] } };
    const input = { request: { ...request('agent'), editor_snapshot: { ...request('agent').editor_snapshot,
      selection: { ...request('agent').editor_snapshot.selection, text: '' } } }, skill: { skill: BUILTIN_WRITING_SKILLS[0]!, inputs: { length: '4000' } },
      brief, candidate: draft, load: async () => null, save: async () => {}, emit: () => {}, signal: new AbortController().signal,
      turn: async (messages: any[]) => { const payload = JSON.parse(messages[1].content); return { role: 'assistant' as const,
        content: JSON.stringify(payload.purpose === 'research_integrate' ? { kind: 'edits', edits: [{ ...(draft.result as any).edits[0], content_markdown: '原理和限制说明 [e1]' }] }
          : { markdown: `## ${payload.section.title}\n\n说明 [e1]`, citation_ids: ['e1'] }) }; } };
    const output = await new ResearchWritingService().chapters(input);
    expect(output.result).toMatchObject({ kind: 'edits', edits: [{ id: 'edit', target: { kind: 'block_range', first_region_id: 'b0' }, content_markdown: '原理和限制说明 [e1]' }] });
  });
});
