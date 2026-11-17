/**
 * @file 研究写作模型阶段。生成研究任务说明、章节安排与审阅结果，并约束修订目标。
 */
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
/**
 * 把阶段说明与数据封装为要求 JSON 输出的模型消息。
 *
 * @param purpose 本次模型阶段的用途标识。
 * @param prompt 发送给模型的提示词。
 * @param data 当前事件或操作携带的数据。
 * @returns 模型消息列表。
 */
const json = (purpose: string, prompt: string, data: unknown): AgentMessage[] => [
  { role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ purpose, ...data as object }) },
];
/**
 * 保留修订前的输出目标，避免修订改变候选的交付类型或位置。
 *
 * @param original 当前待处理的 Agent 候选结果。
 * @param revised 当前待处理的 Agent 候选结果。
 */
function preserveTarget(original: AgentResult, revised: AgentResult) {
  if (original.kind !== revised.kind || original.kind === 'document' && revised.kind === 'document' &&
    (original.document_id !== revised.document_id || original.category_id !== revised.category_id) ||
    original.kind === 'edits' && revised.kind === 'edits' && !isDeepStrictEqual(
      original.edits.map(({ id, operation, target }) => ({ id, operation, target })),
      revised.edits.map(({ id, operation, target }) => ({ id, operation, target })))) throw new Error('修订改变了候选类型或修改目标');
}
export class ResearchWritingService {
  /**
   * 为研究阶段构造角色、提示词版本和输出预算选项。
   *
   * @param role 本次模型或 Worker 执行角色。
   * @param trace_name trace_name 参数（string）。
   * @param maxTokens 本次允许使用的最大 Token 数。
   * @returns 整理后的状态与操作结果对象。
   */
  private options(role: string, trace_name: string, maxTokens: number) {
    return { role, trace_name, maxTokens, json: true, maxAttempts: 1, prompt_version: RESEARCH_PROMPT_VERSION };
  }
  /**
   * 根据用户需求、技能和资料范围生成结构化研究任务说明。
   *
   * @param request 包含写作需求、编辑器快照和参考资料的 Agent 请求。
   * @param plan 待校验或执行的任务计划。
   * @param skill 当前写作技能定义或快照。
   * @param turn 执行模型调用的回调或当前问答轮次。
   * @returns 结构化研究任务说明及其验收要求。
   */
  async brief(request: DocumentAgentDto, plan: ExecutionPlan, skill: WritingSkillSnapshot, turn: ResearchTurn): Promise<ResearchBrief> {
    const response = await turn(json('research_brief', RESEARCH_PROMPTS.brief, {
      query: request.query, plan, skill: { inputs: skill.inputs, acceptance: skill.skill.acceptance },
      scope: { knowledge_scope: request.knowledge_scope, references: request.references.map(({ id, title }) => ({ id, title })), allow_web: request.allow_web },
    }), this.options('plan', 'research_brief', 3000));
    return validateBrief(parseModelJson(response.content ?? ''));
  }
  /**
   * 核对候选与研究目标、证据覆盖的差距，生成质量审阅结果。
   *
   * @param brief 本次研究任务的目标与验收说明。
   * @param candidate 指定子任务已交付的结果和证据。
   * @param dependencies 指定子任务已交付的结果和证据。
   * @param version 本次操作对应的内容版本。
   * @param canResearch 是否仍允许派发补充研究任务。
   * @param turn 执行模型调用的回调或当前问答轮次。
   * @returns 研究覆盖情况、质量缺口与后续修订要求。
   */
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
  /**
   * 依据研究审阅意见修订候选，并保留原交付目标。
   *
   * @param request 包含写作需求、编辑器快照和参考资料的 Agent 请求。
   * @param brief 本次研究任务的目标与验收说明。
   * @param candidate 指定子任务已交付的结果和证据。
   * @param report 当前候选对应的核验或审阅报告。
   * @param turn 执行模型调用的回调或当前问答轮次。
   * @returns 经过整理的 Agent 候选结果。
   */
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
  /**
   * 按目标篇幅和章节安排逐章编写，保存进度后再汇总文稿。
   *
   * @param input 取消信号，用于中止请求和后台处理。
   * @returns 子任务结果、用量与证据。
   */
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
  /**
   * 将当前阶段不可用的原因转换为明确错误。
   *
   * @param error 本次操作捕获的异常。
   */
  private unavailable(error: unknown): never {
    if (error instanceof AgentExecutionError) throw error;
    throw new AgentExecutionError('VERIFICATION_UNAVAILABLE', `研究质量审查未完成：${error instanceof Error ? error.message : '结构无效'}`, true);
  }
}
