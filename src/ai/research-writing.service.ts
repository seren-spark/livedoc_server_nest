import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AgentExecutionError } from './agent-execution.js';
import { parseModelJson, validateAgentResult } from './document-agent.validation.js';
import type { AgentMessage, AgentResult, ExecutionPlan } from './document-agent.types.js';
import type { DocumentAgentDto } from './document-agent.dto.js';
import type { WorkerOutput } from './agent-runtime.types.js';
import type { WritingSkillSnapshot } from './writing-skills.types.js';
import { RESEARCH_PROMPTS, RESEARCH_PROMPT_VERSION } from './research-prompts.js';
import { contentHash, validateBrief, validateResearchReview, type ResearchBrief, type ResearchReview } from './research-writing.js';

export type ResearchTurn = (messages: AgentMessage[], options: any) => Promise<AgentMessage>;
const artifactSchema = z.object({ title: z.string().min(1).max(500).optional(), markdown: z.string().min(1),
  citation_ids: z.array(z.string()).max(200) }).strict();
const json = (purpose: string, prompt: string, data: unknown): AgentMessage[] => [
  { role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ purpose, ...data as object }) },
];
function preserveTarget(original: AgentResult, revised: AgentResult) {
  if (original.kind !== revised.kind || original.kind === 'document' && revised.kind === 'document' &&
    (original.document_id !== revised.document_id || original.category_id !== revised.category_id) ||
    original.kind === 'edits' && revised.kind === 'edits' && !isDeepStrictEqual(
      original.edits.map(({ id, operation, target }) => ({ id, operation, target })),
      revised.edits.map(({ id, operation, target }) => ({ id, operation, target })))) throw new Error('修订改变了候选类型或修改目标');
}
export class ResearchWritingService {
  private options(role: string, trace_name: string, maxTokens: number) {
    return { role, trace_name, maxTokens, json: true, maxAttempts: 1, prompt_version: RESEARCH_PROMPT_VERSION };
  }
  async brief(request: DocumentAgentDto, plan: ExecutionPlan, skill: WritingSkillSnapshot, turn: ResearchTurn): Promise<ResearchBrief> {
    const response = await turn(json('research_brief', RESEARCH_PROMPTS.brief, {
      query: request.query, plan, skill: { inputs: skill.inputs, acceptance: skill.skill.acceptance },
      scope: { knowledge_scope: request.knowledge_scope, references: request.references.map(({ id, title }) => ({ id, title })), allow_web: request.allow_web },
    }), this.options('plan', 'research_brief', 3000));
    return validateBrief(parseModelJson(response.content ?? ''));
  }
  async review(brief: ResearchBrief, candidate: WorkerOutput, dependencies: Record<string, WorkerOutput>, version: number,
    canResearch: boolean, turn: ResearchTurn): Promise<ResearchReview> {
    try {
      const response = await turn(json('research_coverage', RESEARCH_PROMPTS.coverage, {
        brief, candidate: candidate.result, candidate_version: version, can_research: canResearch,
        evidence: candidate.evidence.map(([id, content]) => ({ id, content })),
        research_notes: Object.fromEntries(Object.entries(dependencies).map(([id, output]) => [id, output.research_notes ?? output.handoff])),
      }), this.options('coverage', 'research_coverage', 4000));
      return validateResearchReview(parseModelJson(response.content ?? ''), brief, candidate.result, version, candidate.citations.map(c => c.id));
    } catch (error) { this.unavailable(error); }
  }
  async repair(request: DocumentAgentDto, brief: ResearchBrief, candidate: WorkerOutput, report: unknown, turn: ResearchTurn): Promise<AgentResult> {
    try {
      const response = await turn(json('research_repair', RESEARCH_PROMPTS.repair, {
        query: request.query, brief, candidate: candidate.result, quality_report: report,
        evidence: candidate.evidence.map(([id, content]) => ({ id, content })),
      }), this.options('writer', 'research_repair', 6000));
      const revised = validateAgentResult(parseModelJson(response.content ?? ''), request, new Set(candidate.citations.map(c => c.id)));
      const original = candidate.result;
      preserveTarget(original, revised);
      if (isDeepStrictEqual(original, revised)) throw new Error('修订未改变未通过的候选');
      return revised;
    } catch (error) { this.unavailable(error); }
  }
  async chapters(input: { request: DocumentAgentDto; skill: WritingSkillSnapshot; brief: ResearchBrief; candidate: WorkerOutput;
    turn: ResearchTurn; load: (key: string) => Promise<any>; save: (key: string, value: unknown) => Promise<void>;
    preview?: (evidence: Array<[string, string]>, goal: string) => Array<[string, string]>;
    emit: (event: string, value: Record<string, any>) => void; signal: AbortSignal }): Promise<WorkerOutput> {
    const { request, skill, brief, candidate, turn, load, save, emit, signal } = input;
    const desired = Number((skill.inputs.length ?? '').match(/\d+/u)?.[0] ?? 0);
    if (request.editor_snapshot.selection.text || !['document', 'edits'].includes(candidate.result.kind) || desired < 4000 && brief.sections.length < 4) return candidate;
    const available = new Set(candidate.citations.map(c => c.id));
    const chapters: Array<{ title: string; markdown: string; citation_ids: string[] }> = [];
    for (const section of brief.sections) {
      signal.throwIfAborted();
      const notes = candidate.research_notes?.filter(n => section.question_ids.includes(n.question_id));
      const related = new Set(notes?.flatMap(n => [...n.findings, ...n.conflicts].flatMap(f => f.evidence_ids)));
      const sources = related.size ? candidate.evidence.filter(([id]) => related.has(id)) : candidate.evidence;
      const evidence = (input.preview ? input.preview(sources, `${section.title}\n${brief.questions.filter(q => section.question_ids.includes(q.id)).map(q => q.text).join('\n')}`) : sources)
        .map(([id, content]) => ({ id, content }));
      const fingerprint = contentHash({ brief, section, evidence, prompt: RESEARCH_PROMPT_VERSION });
      const key = `research:chapter:${section.id}:${fingerprint}`;
      let chapter = await load(key);
      if (!chapter) {
        emit('research_section', { section_id: section.id, title: section.title, status: 'writing' });
        const result = await turn(json('research_section', RESEARCH_PROMPTS.section, { brief, section,
          evidence: evidence.map(e => ({ ...e, content: e.content })),
          notes,
        }), this.options('writer', 'research_section', 4000));
        chapter = { ...artifactSchema.parse(parseModelJson(result.content ?? '')), title: section.title };
        if (chapter.citation_ids.some((id: string) => !available.has(id))) throw new Error('章节引用未交付的证据');
        signal.throwIfAborted(); await save(key, chapter);
      }
      emit('research_section', { section_id: section.id, title: section.title, status: 'done' });
      chapters.push(chapter);
    }
    const result = await turn(json('research_integrate', RESEARCH_PROMPTS.integrate, { brief, chapters, candidate: candidate.result }),
      this.options('writer', 'research_integrate', 8000));
    const value = parseModelJson(result.content ?? '');
    let revised: AgentResult;
    if (candidate.result.kind === 'document') {
      const integrated = artifactSchema.parse(value);
      revised = { ...candidate.result, title: integrated.title ?? candidate.result.title, markdown: integrated.markdown, citation_ids: integrated.citation_ids };
    } else revised = validateAgentResult(value, request, available);
    preserveTarget(candidate.result, revised);
    validateAgentResult(revised, request, available);
    signal.throwIfAborted();
    return { ...candidate, result: revised };
  }
  private unavailable(error: unknown): never {
    if (error instanceof AgentExecutionError) throw error;
    throw new AgentExecutionError('VERIFICATION_UNAVAILABLE', `研究质量审查未完成：${error instanceof Error ? error.message : '结构无效'}`, true);
  }
}
