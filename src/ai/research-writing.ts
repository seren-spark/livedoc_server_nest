import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentResult, AgentCitation } from './document-agent.types.js';
import type { WorkerHandoff } from './agent-handoff.js';

const id = z.string().min(1).max(160);
const text = z.string().trim().min(1).max(4000);
export const briefSchema = z.object({
  goal: text, audience: z.string().max(2000), deliverable: text,
  constraints: z.array(text).max(30), unknowns: z.array(text).max(20), preferred_sources: z.array(text).max(20),
  questions: z.array(z.object({ id, text, section_ids: z.array(id).min(1).max(12) }).strict()).min(1).max(20),
  sections: z.array(z.object({ id, title: text, question_ids: z.array(id).min(1).max(20) }).strict()).min(1).max(12),
}).strict();
export type ResearchBrief = z.infer<typeof briefSchema>;
export function validateBrief(value: unknown): ResearchBrief {
  const brief = briefSchema.parse(value);
  const questions = new Map(brief.questions.map(q => [q.id, q]));
  const sections = new Map(brief.sections.map(s => [s.id, s]));
  if (questions.size !== brief.questions.length || sections.size !== brief.sections.length ||
    brief.questions.some(q => new Set(q.section_ids).size !== q.section_ids.length ||
      q.section_ids.some(s => !sections.get(s)?.question_ids.includes(q.id))) ||
    brief.sections.some(s => new Set(s.question_ids).size !== s.question_ids.length ||
      s.question_ids.some(q => !questions.get(q)?.section_ids.includes(s.id)))) throw new Error('研究问题和章节映射无效');
  return brief;
}

export type ResearchNote = { question_id: string; findings: WorkerHandoff['findings']; missing: string[]; conflicts: WorkerHandoff['conflicts'] };
export function validateResearchNotes(value: unknown, brief: ResearchBrief, adopted: string[], observations: Array<{ citation_id: string; content: string }>): ResearchNote[] {
  const notes = z.array(z.object({ question_id: id,
    findings: z.array(z.object({ statement: text, evidence_ids: z.array(id).min(1).max(20) }).strict()).max(40),
    missing: z.array(text).max(30), conflicts: z.array(z.object({ description: text, evidence_ids: z.array(id).min(2).max(20) }).strict()).max(20),
  }).strict()).max(20).parse(value);
  const allowed = new Set(adopted), observed = new Set(observations.filter(o => o.content.trim()).map(o => o.citation_id));
  if (new Set(notes.map(n => n.question_id)).size !== notes.length || notes.some(n =>
    !brief.questions.some(q => q.id === n.question_id) ||
    [...n.findings, ...n.conflicts].some(f => f.evidence_ids.some(e => !allowed.has(e) || !observed.has(e))) ||
    !n.findings.length && !n.missing.length && !n.conflicts.length)) throw new Error('研究明细缺少有效问题或已观察证据');
  return notes;
}

export type ResearchProgress = { searches: number; consecutive_empty: number; seen_queries: string[]; evidence_hashes: string[]; stop_reason?: string };
export const emptyResearchProgress = (): ResearchProgress => ({ searches: 0, consecutive_empty: 0, seen_queries: [], evidence_hashes: [] });
export const isResearchSearch = (name: string) => ['search_knowledge_base', 'search_web', 'personal_tavily_search'].includes(name) || name.startsWith('mcp__') && /search/iu.test(name);
export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function researchSearchStart(progress: ResearchProgress, name: string, args: any, brief: ResearchBrief) {
  if (progress.stop_reason || progress.searches >= 3) throw new Error('本研究步骤已停止搜索，请提交已知发现与缺口');
  if (!brief.questions.some(q => q.id === args.question_id) || typeof args.gap_reason !== 'string' || !args.gap_reason.trim())
    throw new Error('搜索必须关联有效question_id并说明gap_reason');
  const key = contentHash([name, String(args.query ?? '').trim().toLocaleLowerCase().replace(/\s+/gu, ' '), Boolean(args.original_only)]);
  if (progress.seen_queries.includes(key)) { progress.stop_reason = 'repeated_query'; throw new Error('重复查询已停止，请交付研究结果'); }
  progress.seen_queries.push(key); progress.searches++;
}
export function researchSearchEnd(progress: ResearchProgress, observations: Array<{ citation_id: string; content: string }>, citations: Map<string, AgentCitation>) {
  let added = 0;
  for (const observation of observations) {
    if (!observation.content.trim()) continue;
    const source = citations.get(observation.citation_id);
    if (!source) continue;
    // Citation IDs contain tool-call IDs. Deduplicate stable source plus actually returned content instead.
    const key = contentHash([source?.url ?? source?.doc_id ?? source?.reference_id ?? observation.citation_id,
      source?.version, source?.snapshot_hash, observation.content]);
    if (!progress.evidence_hashes.includes(key)) { progress.evidence_hashes.push(key); added++; }
  }
  progress.consecutive_empty = added ? 0 : progress.consecutive_empty + 1;
  if (progress.consecutive_empty >= 2) progress.stop_reason = 'no_new_evidence';
  else if (progress.searches >= 3) progress.stop_reason = 'search_limit';
  return added;
}

export const coverageSchema = z.object({ candidate_version: z.number().int().nonnegative(), items: z.array(z.object({
  question_id: id, status: z.enum(['covered', 'partial', 'missing', 'conflicted']),
  locations: z.array(z.object({ field: z.enum(['answer', 'markdown', 'edit']), edit_id: id.optional(),
    start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()).max(30),
  citation_ids: z.array(id).max(40), reason: text, gap_declared: z.boolean(),
}).strict()).max(20), recovery: z.object({ action: z.enum(['none', 'repair', 'research', 'clarify']),
  instruction: z.string().max(8000), question: text.optional() }).strict() }).strict();
export type ResearchReview = z.infer<typeof coverageSchema> & { deliverable: boolean; completeness: 'complete' | 'partial' };
export function candidateText(candidate: AgentResult, field: string, editId?: string): string | undefined {
  if (candidate.kind === 'document' && field === 'markdown') return candidate.markdown;
  if (candidate.kind === 'answer' && field === 'answer') return candidate.answer;
  if (candidate.kind === 'edits' && field === 'edit') return candidate.edits.find(e => e.id === editId)?.content_markdown;
}
export function validateResearchReview(value: unknown, brief: ResearchBrief, candidate: AgentResult, version: number, evidenceIds: string[]): ResearchReview {
  const report = coverageSchema.parse(value), known = new Set(evidenceIds);
  if (report.candidate_version !== version || report.items.length !== brief.questions.length ||
    new Set(report.items.map(i => i.question_id)).size !== report.items.length) throw new Error('覆盖报告版本或问题数量失配');
  for (const item of report.items) {
    if (!brief.questions.some(q => q.id === item.question_id) || item.citation_ids.some(e => !known.has(e))) throw new Error('覆盖报告引用未知问题或证据');
    for (const location of item.locations) {
      const value = candidateText(candidate, location.field, location.edit_id);
      if (value === undefined || location.end > value.length || location.end <= location.start || !value.slice(location.start, location.end).trim())
        throw new Error('覆盖报告文章位置无效');
    }
    if ((item.status === 'covered' || item.gap_declared) && !item.locations.length) throw new Error('覆盖内容或缺口声明必须有实际文章位置');
    if (item.status === 'covered' && !item.citation_ids.length) throw new Error('已覆盖问题缺少证据');
  }
  const complete = report.items.every(i => i.status === 'covered');
  const deliverable = report.recovery.action === 'none' && report.items.every(i => i.status === 'covered' || i.gap_declared);
  if (report.recovery.action === 'none' && !deliverable || report.recovery.action !== 'none' && !report.recovery.instruction.trim() ||
    report.recovery.action === 'clarify' && !report.recovery.question?.trim()) throw new Error('覆盖问题缺少有效恢复动作');
  return { ...report, deliverable, completeness: complete ? 'complete' : 'partial' };
}

export interface WebSourceSnapshot { content: string; hash: string; fetched_at: string; complete: boolean }
export function sourceExcerpts(content: string, query: string, maxChars = 5000): Array<{ start: number; end: number; text: string }> {
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  // CJK queries are often an entire sentence; bigrams retain useful terms without a new tokenizer.
  const keywords = [...new Set(terms.flatMap(t => /[\u4e00-\u9fff]/u.test(t) ? [...t].slice(0, -1).map((_, i) => t.slice(i, i + 2)) : [t]))];
  const blocks: Array<{ start: number; end: number; text: string; score: number }> = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(content.length, start + 1000);
    if (end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1]!)) end--;
    const text = content.slice(start, end), lower = text.toLocaleLowerCase();
    blocks.push({ start, end, text, score: keywords.filter(t => lower.includes(t)).length }); start = end;
  }
  let remaining = maxChars;
  return blocks.sort((a, b) => b.score - a.score || a.start - b.start).filter(b => {
    if (b.text.length > remaining) return false; remaining -= b.text.length; return true;
  }).sort((a, b) => a.start - b.start).map(({ start, end, text }) => ({ start, end, text }));
}
