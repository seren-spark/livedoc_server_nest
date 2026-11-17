/**
 * @file 写作技能。管理技能定义，校验步骤与输入，并转换为任务可执行计划。
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import type { AccessContext } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';
import { DOCUMENT_AGENT_TOOLS } from './document-agent-tools.service.js';
import { PERSONAL_WEB_TOOLS } from './agent-settings.service.js';
import { validatePlan } from './document-agent.validation.js';
import type { ExecutionPlan } from './document-agent.types.js';
import type {
  SaveWritingSkillInput, SkillMetadata, SkillSelection, WritingSkill, WritingSkillDefinition, WritingSkillSnapshot,
} from './writing-skills.types.js';

const inputSchema = {
  type: 'object', additionalProperties: false,
  required: ['name', 'description', 'parameters', 'steps', 'allowed_tools', 'acceptance'],
  properties: {
    workflow: { enum: ['standard', 'research_writing'] },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', minLength: 1, maxLength: 1000 },
    parameters: { type: 'array', maxItems: 8, items: {
      type: 'object', additionalProperties: false, required: ['name', 'label', 'required'],
      properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' },
        label: { type: 'string', minLength: 1, maxLength: 100 }, required: { type: 'boolean' } },
    } },
    steps: { type: 'array', minItems: 1, maxItems: 5, items: {
      type: 'object', additionalProperties: false, required: ['id', 'description', 'depends_on', 'capability'],
      properties: { id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
        description: { type: 'string', minLength: 1, maxLength: 2000 },
        depends_on: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
        capability: { enum: ['read', 'search', 'compose'] } },
    } },
    allowed_tools: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 } },
    acceptance: { type: 'array', minItems: 1, maxItems: 10,
      items: { type: 'string', minLength: 1, maxLength: 500 } },
    template_id: { type: 'string', minLength: 1, maxLength: 128 },
    enabled: { type: 'boolean' },
    expected_revision: { type: 'integer', minimum: 0 },
  },
};

const builtinTools = [
  'read_current_document', 'read_reference', 'read_knowledge_document', 'search_knowledge_base',
  'read_task_evidence',
  'search_web', 'list_templates', 'read_template', 'list_categories', 'finish_answer', 'submit_plan',
  'request_clarification', 'propose_new_document', 'propose_document_edits',
];

export const BUILTIN_WRITING_SKILLS: readonly WritingSkill[] = [
  {
    skill_id: 'builtin-research-writing', revision: 1, builtin: true, enabled: true, workflow: 'research_writing',
    name: '研究型写作', description: '先拆解必答问题，再按缺口研究，核验事实与要求覆盖后生成可采纳草稿。',
    parameters: [{ name: 'audience', label: '目标读者', required: false }, { name: 'length', label: '目标字数', required: false }],
    steps: [
      { id: 'read_sources', capability: 'read', description: '读取当前文档与所选资料，整理已有依据和边界。', depends_on: [] },
      { id: 'research_questions', capability: 'search', description: '按照研究简报逐问题收集证据，根据未解决缺口定向继续搜索，保留冲突与资料不足。', depends_on: ['read_sources'] },
    ],
    allowed_tools: [...builtinTools, 'read_research_notes', ...PERSONAL_WEB_TOOLS.map(tool => tool.function.name)],
    acceptance: ['逐项回答用户的必答问题，不能只有标题。', '关键结论与附近引用对应，不扩大证据的条件与范围。', '缺少案例、指标或来源存在冲突时明确说明，不编造。'],
  },
  {
    skill_id: 'builtin-technical-article', revision: 1, builtin: true, enabled: true,
    name: '技术文章', description: '基于已选资料整理术语和依据，规划技术文章，保留代码并核验关键结论。',
    parameters: [{ name: 'audience', label: '目标读者', required: false }],
    steps: [
      { id: 'read_sources', capability: 'read', description: '读取当前文档与已选资料，整理术语、代码和已有事实。', depends_on: [] },
      { id: 'research_facts', capability: 'search', description: '在授权资料范围核实关键事实，明确缺失信息和冲突。', depends_on: ['read_sources'] },
      { id: 'compose_article', capability: 'compose', description: '面向{{audience}}组织技术文章，按用户要求规划结构，保留代码与准确引用。', depends_on: ['read_sources', 'research_facts'] },
    ],
    allowed_tools: builtinTools,
    acceptance: ['代码块保持完整，修改代码需要用户明确要求。', '关键事实具有可定位的证据，资料缺失的指标明确说明。'],
    template_id: 'builtin-technical',
  },
  {
    skill_id: 'builtin-meeting-notes', revision: 1, builtin: true, enabled: true,
    name: '会议纪要', description: '从会议记录提取讨论、决策和行动项，保留缺失负责人与时间的待确认状态。',
    parameters: [{ name: 'meeting_title', label: '会议名称', required: false }],
    steps: [
      { id: 'read_record', capability: 'read', description: '读取会议记录，识别讨论、决策、负责人及时间原文。', depends_on: [] },
      { id: 'compose_notes', capability: 'compose', description: '整理{{meeting_title}}会议纪要及行动项，缺失负责人或日期标为待确认。', depends_on: ['read_record'] },
    ],
    allowed_tools: builtinTools,
    acceptance: ['决策与行动项可追溯到会议记录。', '负责人或日期缺失时标为待确认，不推测补全。'],
    template_id: 'builtin-meeting',
  },
  {
    skill_id: 'builtin-source-comparison', revision: 1, builtin: true, enabled: true,
    name: '资料对比', description: '按明确维度比较多份资料，分别记录来源、共同点、差异、冲突与缺项。',
    parameters: [{ name: 'dimensions', label: '对比维度', required: false }],
    steps: [
      { id: 'read_materials', capability: 'read', description: '分别阅读已选资料，确定{{dimensions}}等对比维度与来源。', depends_on: [] },
      { id: 'research_differences', capability: 'search', description: '在已授权范围核实差异和冲突，保留不可比较的缺项。', depends_on: ['read_materials'] },
      { id: 'compose_comparison', capability: 'compose', description: '按维度汇总对比，每项事实绑定对应资料，明确矛盾与资料边界。', depends_on: ['read_materials', 'research_differences'] },
    ],
    allowed_tools: builtinTools,
    acceptance: ['各资料的事实与引用保持正确归属。', '资料冲突和缺项明确保留，不编造统一结论。'],
  },
];

/**
 * 根据用户与空间生成隔离存储使用的键。
 *
 * @param context 当前用户、空间与团队身份，用于权限校验。
 * @returns 整理后的文本或标识。
 */
const scopeKey = (context: AccessContext) => JSON.stringify([context.space_id, context.user_id]);
/**
 * 解析持久化的写作技能定义。
 *
 * @param value 待校验或转换的值。
 * @returns WritingSkillDefinition 类型的处理结果。
 */
const parseDefinition = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as WritingSkillDefinition;

@Injectable()
export class WritingSkillsService {
  private readonly memory = new Map<string, Map<string, WritingSkill>>();
  private readonly validateInput = new Ajv({ strict: false }).compile(inputSchema);
  private readonly toolNames = new Set([...DOCUMENT_AGENT_TOOLS, ...PERSONAL_WEB_TOOLS].map((tool) => tool.function.name));

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   * @param workspace WorkspaceService 依赖实例。
   */
  constructor(private readonly database: DatabaseService, private readonly workspace: WorkspaceService) {}

  /**
   * 按查询条件读取写作技能列表。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的结果列表。
   */
  async list(context: AccessContext): Promise<SkillMetadata[]> {
    return (await this.all(context)).map(({ skill_id, revision, builtin, name, description, parameters, enabled }) =>
      ({ skill_id, revision, builtin, name, description, parameters: structuredClone(parameters), enabled }));
  }

  /**
   * 按标识读取写作技能。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param id 目标记录的唯一标识。
   * @returns WritingSkill 类型的处理结果。
   */
  async get(context: AccessContext, id: string): Promise<WritingSkill> {
    const skill = (await this.all(context)).find((item) => item.skill_id === id);
    if (!skill) throw new NotFoundException('写作 Skill 不存在');
    return structuredClone(skill);
  }

  /**
   * 校验技能定义与修订号后保存个人技能，内置技能保持只读。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param input 本次操作的输入数据。
   * @param id 目标记录的唯一标识（可选）。
   * @returns WritingSkill 类型的处理结果。
   */
  async save(context: AccessContext, input: SaveWritingSkillInput, id?: string): Promise<WritingSkill> {
    if (id?.startsWith('builtin-')) throw new ForbiddenException('内置 Skill 只读，请复制为个人版本');
    if (!this.validateInput(input)) throw new BadRequestException('写作 Skill 定义无效');
    const existing = id ? await this.get(context, id) : undefined;
    const expected = input.expected_revision ?? 0;
    if (expected !== (existing?.revision ?? 0)) throw new ConflictException('写作 Skill 已变更，请重新加载');
    const { expected_revision: _expected, ...fields } = input;
    const definition: WritingSkillDefinition = structuredClone({ ...fields, enabled: fields.enabled ?? existing?.enabled ?? true });
    this.validateDefinition(definition);
    if (definition.template_id) await this.workspace.getTemplate(context, definition.template_id);
    const skill: WritingSkill = { ...definition, skill_id: id ?? randomUUID(), revision: expected + 1, builtin: false };
    if (this.database.metadataEnabled) {
      if (existing) {
        const result = await this.database.source.query(
          'UPDATE writing_skills SET revision=?,definition=? WHERE skill_id=? AND owner_id=? AND space_id=? AND revision=?',
          [skill.revision, JSON.stringify(definition), skill.skill_id, context.user_id, context.space_id, expected],
        );
        if (!result.affectedRows) throw new ConflictException('写作 Skill 已变更，请重新加载');
      } else {
        await this.database.query('INSERT INTO writing_skills(skill_id,owner_id,space_id,revision,definition) VALUES(?,?,?,?,?)',
          [skill.skill_id, context.user_id, context.space_id, skill.revision, JSON.stringify(definition)]);
      }
    } else {
      const map = this.memory.get(scopeKey(context)) ?? new Map<string, WritingSkill>();
      if ((map.get(skill.skill_id)?.revision ?? 0) !== expected) throw new ConflictException('写作 Skill 已变更，请重新加载');
      map.set(skill.skill_id, structuredClone(skill));
      this.memory.set(scopeKey(context), map);
    }
    return structuredClone(skill);
  }

  /**
   * 校验个人技能的修订版本后删除定义。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param id 目标记录的唯一标识。
   * @param expectedRevision 调用方期望操作的状态修订号。
   */
  async delete(context: AccessContext, id: string, expectedRevision: number): Promise<void> {
    if (id.startsWith('builtin-')) throw new ForbiddenException('内置 Skill 只读');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new BadRequestException('需要有效的 Skill 版本');
    await this.get(context, id);
    if (this.database.metadataEnabled) {
      const result = await this.database.source.query(
        'DELETE FROM writing_skills WHERE skill_id=? AND owner_id=? AND space_id=? AND revision=?',
        [id, context.user_id, context.space_id, expectedRevision],
      );
      if (!result.affectedRows) throw new ConflictException('写作 Skill 已变更，请重新加载');
    } else {
      const map = this.memory.get(scopeKey(context));
      if (map?.get(id)?.revision !== expectedRevision) throw new ConflictException('写作 Skill 已变更，请重新加载');
      map.delete(id);
    }
  }

  /**
   * 检查技能版本、启用状态与参数，生成当前任务固定使用的技能快照。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param selection 当前选区的范围与文本信息。
   * @returns 固定版本的写作技能快照。
   */
  async snapshot(context: AccessContext, selection: SkillSelection): Promise<WritingSkillSnapshot> {
    const skill = await this.get(context, selection.skill_id);
    if (selection.skill_revision !== undefined && selection.skill_revision !== skill.revision)
      throw new ConflictException('所选 Skill 已变更，请重新选择');
    if (!skill.enabled) throw new ConflictException('所选 Skill 已停用');
    const inputs = selection.skill_inputs ?? {};
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new BadRequestException('Skill 输入无效');
    const names = new Set(skill.parameters.map((parameter) => parameter.name));
    if (Object.keys(inputs).some((key) => !names.has(key)) ||
      Object.values(inputs).some((value) => typeof value !== 'string' || value.length > 2000) ||
      Object.values(inputs).join('').length > 8000 ||
      skill.parameters.some((parameter) => parameter.required && !inputs[parameter.name]?.trim()))
      throw new BadRequestException('Skill 输入缺少必填项或包含无效参数');
    const templateId = selection.template_id ?? skill.template_id;
    const template = templateId ? await this.workspace.getTemplate(context, templateId) : undefined;
    return structuredClone({ skill, inputs, ...(template ? { template } : {}) });
  }

  /**
   * 根据技能步骤及用户输入生成可执行计划。
   *
   * @param snapshot 任务开始时保存的文档或配置快照。
   * @param query 用户问题或检索查询。
   * @returns 可执行的任务计划。
   */
  toPlan(snapshot: WritingSkillSnapshot, query: string): ExecutionPlan {
    /**
     * 用用户输入替换技能定义中的参数占位符。
     *
     * @param text 待处理的文本。
     * @returns 整理后的文本或标识。
     */
    const fill = (text: string) => text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gu,
      (_match, key: string) => snapshot.inputs[key]?.trim() || '用户指定要求');
    return validatePlan({ goal: query, outline: [], constraints: [...snapshot.skill.acceptance],
      steps: snapshot.skill.steps.map((step) => ({ ...structuredClone(step), description: fill(step.description) })) });
  }

  /**
   * 检查技能参数、步骤依赖与验收要求是否合法。
   *
   * @param definition 写作技能或模板的完整定义。
   */
  private validateDefinition(definition: WritingSkillDefinition) {
    if (![definition.name, definition.description, ...definition.acceptance].every((text) => text.trim()))
      throw new BadRequestException('Skill 名称、描述与验收要求不能为空');
    const names = definition.parameters.map((parameter) => parameter.name);
    if (new Set(names).size !== names.length || names.some((name) => ['constructor', 'prototype'].includes(name)) ||
      definition.parameters.some((parameter) => !parameter.label.trim()))
      throw new BadRequestException('Skill 参数名称重复或无效');
    if (definition.allowed_tools.some((name) => !this.toolNames.has(name))) throw new BadRequestException('Skill 包含未注册的工具名');
    validatePlan({ goal: definition.name, outline: [], constraints: definition.acceptance, steps: definition.steps });
    for (const step of definition.steps) {
      if ([...step.description.matchAll(/\{\{([^{}]+)\}\}/gu)].some((match) => !names.includes(match[1]!)))
        throw new BadRequestException('Skill 步骤引用了未定义参数');
    }
  }

  /**
   * 汇总内置定义与当前用户保存的自定义定义。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的结果列表。
   */
  private async all(context: AccessContext): Promise<WritingSkill[]> {
    const personal = this.database.metadataEnabled
      ? (await this.database.query<{ skill_id: string; revision: number; definition: unknown }>(
        'SELECT skill_id,revision,definition FROM writing_skills WHERE owner_id=? AND space_id=? ORDER BY skill_id',
        [context.user_id, context.space_id],
      )).map((row) => ({ ...parseDefinition(row.definition), skill_id: row.skill_id, revision: Number(row.revision), builtin: false }))
      : [...(this.memory.get(scopeKey(context))?.values() ?? [])];
    return structuredClone([...BUILTIN_WRITING_SKILLS, ...personal]);
  }
}
