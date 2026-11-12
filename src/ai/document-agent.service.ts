import { ConversationConstraintsService, agentMemoryDocumentId, type ConstraintTurn } from './conversation-constraints.service.js';
import { WritingSkillsService } from './writing-skills.service.js';
import type { WritingSkillSnapshot } from './writing-skills.types.js';
import { WritingPreferencesService } from './writing-preferences.service.js';
import type { PreferenceSnapshot } from './writing-preferences.types.js';
import { AgentRuntimeService } from "./agent-runtime.service.js";
import { AgentSupervisorService } from "./agent-supervisor.service.js";
import {
  agentRegionHash,
  rebaseAgentDelivery,
} from "./document-agent-recovery.js";
import { WikiService } from "../wiki/wiki.service.js";
import type { WikiProof, WikiKnowledgeSnapshot } from "../wiki/wiki.types.js";
import {
  emptyUsage,
  withAbort,
  type WorkerEnvironment,
  type WorkerOutput,
} from "./agent-runtime.types.js";
import { writingGuidance } from "./document-agent-tools.service.js";
import {
  AgentExecutionError,
  agentFailure,
  startAgentSpan,
} from "./agent-execution.js";
export { DOCUMENT_AGENT_TOOLS } from "./document-agent-tools.service.js";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AppConfig } from "../config/app-config.js";
import { DocumentsService } from "../documents/documents.service.js";
import { DocumentImportsService } from "../document-imports/document-imports.service.js";
import { ArticleRepository } from "../articles/article.repository.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { ConversationMemoryService } from "./memory.service.js";
import { DocumentMemoryService } from "../documents/document-memory/document-memory.service.js";
import { LlmService } from "./llm.service.js";
import { AgentMcpService } from "./agent-mcp.service.js";
import {
  AgentSettingsService,
  PERSONAL_WEB_TOOLS,
} from "./agent-settings.service.js";
import {
  AgentAuditService,
  type AgentRunRecord,
} from "./agent-audit.service.js";
import type { DocumentAgentDto } from "./document-agent.dto.js";
import type { AccessContext } from "../common/types.js";
import type {
  AgentCitation,
  AgentEvent,
  AgentMessage,
  AgentResult,
  ExecutionPlan,
  FunctionTool,
} from "./document-agent.types.js";
import {
  parseModelJson,
  validateAgentRequest,
  validateAgentResult,
  validatePlan,
  selectAgentCitations,
} from "./document-agent.validation.js";

type Route = {
  strategy: "react" | "plan_execute";
  source: string;
  reason: string;
};
function planSummary(plan: ExecutionPlan) {
  return {
    goal: plan.goal.slice(0, 300),
    outline: plan.outline.map((title) => title.slice(0, 100)),
    steps: plan.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      description: step.description.slice(0, 300),
    })),
  };
}
export function ruleRoute(request: DocumentAgentDto): Route | null {
  if (request.confirmed_plan)
    return {
      strategy: "plan_execute",
      source: "confirmed_plan",
      reason: "执行用户确认计划",
    };
  if (request.mode === "plan")
    return {
      strategy: "plan_execute",
      source: "rule",
      reason: "生成可调整的写作计划",
    };
  const q = request.query;
  if (
    /先[\s\S]*(?:然后|再)|如果[\s\S]*否则|整篇|全文重组|多(?:个|处|章节)|综合|对比.*(?:生成|编写|总结)|分析.*(?:整理|编写)/u.test(
      q,
    ) ||
    (request.references.length > 1 && /生成|写|总结|对比/u.test(q))
  )
    return {
      strategy: "plan_execute",
      source: "rule",
      reason: "任务需要多个步骤或综合资料",
    };
  if (
    (request.editor_snapshot.selection.text &&
      /改写|润色|纠错|摘要|简化/u.test(q)) ||
    /^(?:查询|查找|续写|插入|解释|总结当前选区)/u.test(q)
  )
    return {
      strategy: "react",
      source: "rule",
      reason: "明确的单次读取或编辑任务",
    };
  return null;
}
@Injectable()
export class DocumentAgentService {
  // ponytail: process-local admission control; a shared store is needed before multiple API replicas.
  private readonly active = new Set<string>();
  private readonly admissions = new Map<string, number[]>();
  private readonly feedbackWrites = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: AppConfig,
    private readonly llm: LlmService,
    private readonly documents: DocumentsService,
    private readonly imports: DocumentImportsService,
    private readonly articles: ArticleRepository,
    private readonly workspace: WorkspaceService,
    private readonly memory: ConversationMemoryService,
    private readonly documentMemory: DocumentMemoryService,
    private readonly mcp: AgentMcpService,
    private readonly audit: AgentAuditService,
    private readonly settings: AgentSettingsService,
    private readonly runtime: AgentRuntimeService,
    private readonly supervisor: AgentSupervisorService,
    private readonly wiki: WikiService,
    private readonly constraints?: ConversationConstraintsService,
    private readonly skills?: WritingSkillsService,
    private readonly preferences?: WritingPreferencesService,
  ) {}

  async capabilities(context?: AccessContext) {
    const personal = context ? await this.settings.runtime(context) : undefined;
    const deploymentWeb = personal?.deployment_web ?? true;
    const mcpWeb =
      deploymentWeb && this.config.mcpEnabled && this.mcp.tools.size > 0;
    const nativeWeb = deploymentWeb && this.llm.webSearchConfigured;
    return {
      enabled: this.config.documentAgentEnabled,
      graph_enabled: this.config.agentGraphEnabled,
      skills_enabled: this.config.agentGraphEnabled && this.config.agentGraphVersion === 'v2',
      research_writing_available: this.config.agentGraphEnabled && this.config.agentGraphVersion === 'v2',
      preferences_enabled: this.config.agentGraphEnabled && this.config.agentGraphVersion === 'v2',
      workspace_enabled: this.config.workspaceEnabled,
      thinking_supported:
        personal?.thinking_supported ?? this.config.thinkingSupported,
      web_available: Boolean(personal?.web_key || mcpWeb || nativeWeb),
      web_tools: [
        ...(nativeWeb ? ["search_web"] : []),
        ...(mcpWeb ? this.mcp.tools.keys() : []),
        ...(personal?.web_key
          ? PERSONAL_WEB_TOOLS.map((t) => t.function.name)
          : []),
      ],
      unavailable_servers: this.mcp.unavailable,
      limits: {
        references: 10,
        text_file_bytes: 2 * 1024 * 1024,
        upload_mb: this.config.importMaxUploadMb,
        max_tool_calls: this.config.agentMaxToolCalls,
        max_plan_steps: this.supervisor.maxPlanSteps(),
        max_total_tokens: this.config.agentMaxTotalTokens,
        max_model_requests: this.config.agentMaxModelRequests,
        total_seconds: this.config.agentTimeoutSeconds,
      },
    };
  }
  async validateIdentity(
    request: DocumentAgentDto,
    context: AccessContext,
    personal?: Awaited<ReturnType<AgentSettingsService["runtime"]>>,
    allowSnapshotVersionChange = false,
  ) {
    validateAgentRequest(request);
    if (!this.config.documentAgentEnabled)
      throw new NotFoundException("文档 Agent 未启用");
    personal ??= await this.settings.runtime(context);
    if (request.deep_thinking && !personal.thinking_supported)
      throw new BadRequestException("当前模型未配置深度思考能力");
    if (
      request.allow_web &&
      !personal.web_key &&
      !(
        personal.deployment_web &&
        (this.llm.webSearchConfigured ||
          (this.config.mcpEnabled && this.mcp.tools.size > 0))
      )
    )
      throw new BadRequestException("联网资料工具不可用");
    const identity = request.editor_snapshot.identity;
    if (identity.kind === "knowledge") {
      const document = await this.documents.getAccessible(
        identity.doc_id,
        context,
      );
      if (
        !allowSnapshotVersionChange &&
        document.document_version !== identity.persisted_version
      )
        throw new ConflictException("文档版本已更新，请刷新后重新生成");
    } else if (identity.kind === "article") {
      const article = await this.articles.requireOwner(
        identity.article_id,
        context,
      );
      if (
        !allowSnapshotVersionChange &&
        article.draft_version !== identity.draft_version
      )
        throw new ConflictException("文章草稿版本已更新");
    } else if (identity.kind === "import") {
      const imported = await this.imports.require(identity.import_id);
      this.imports.assertOwner(imported, context);
      if (imported.document_id)
        await this.documents.getAccessible(imported.document_id, context);
    }
    for (const ref of request.references) {
      if (ref.kind === "document")
        await this.documents.getAccessible(ref.doc_id!, context);
      if (ref.kind === "import") {
        const imported = await this.imports.require(ref.import_id!);
        this.imports.assertOwner(imported, context);
        if (imported.document_id)
          await this.documents.getAccessible(imported.document_id, context);
        if (!["review_ready", "confirmed"].includes(imported.status))
          throw new BadRequestException("参考文件尚未解析完成");
      }
    }
    if (request.template_id)
      await this.workspace.getTemplate(context, request.template_id);
    if (request.confirmed_plan)
      this.supervisor.assertPlanFits(request.confirmed_plan);
  }
  async *run(
    request: DocumentAgentDto,
    context: AccessContext,
    external: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const signal = AbortSignal.any([
      external,
      AbortSignal.timeout(this.config.agentTimeoutSeconds * 1000),
    ]);
    const personal = await withAbort(this.settings.runtime(context), signal);
    await withAbort(this.validateIdentity(request, context, personal), signal);
    if (!this.llm.isConfigured)
      throw new ServiceUnavailableException("请配置模型后使用文档 Agent");
    const admissionKey = `${context.space_id}:${context.user_id}`;
    const now = Date.now();
    const times = (this.admissions.get(admissionKey) ?? []).filter(
      (t) => now - t < 60000,
    );
    if (
      this.active.size >= this.config.agentMaxConcurrentRuns ||
      this.active.has(admissionKey) ||
      times.length >= 10
    )
      throw new HttpException(
        {
          code: "AGENT_RATE_LIMIT",
          message: "已有任务执行中或达到每分钟任务限额",
          retry_after: 60,
        },
        429,
      );
    this.active.add(admissionKey);
    this.admissions.set(admissionKey, [...times, now]);
    const run: AgentRunRecord = {
      run_id: randomUUID(),
      request_id: request.request_id,
      user_id: context.user_id,
      space_id: context.space_id,
      conversation_id: request.conversation_id,
      mode: request.mode,
      status: "routing",
      payload: {
        identity: request.editor_snapshot.identity,
        snapshot_hash: createHash("sha256")
          .update(JSON.stringify(request.editor_snapshot.json))
          .digest("hex"),
        output_target: request.output_target,
        query: request.query,
        config_fingerprint: this.config.configFingerprint,
        limits: {
          total_tokens: this.config.agentMaxTotalTokens,
          model_requests: this.config.agentMaxModelRequests,
        },
        feedback: {},
        traces: [],
      },
    };
    let seq = 0;
    const emit = (
      event: string,
      data: Record<string, any> = {},
    ): AgentEvent => ({
      event,
      data: { run_id: run.run_id, seq: ++seq, ...data },
    });
    let eventSinkClosed = false;
    const events: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const enqueue = (event: string, data: Record<string, any>) => {
      if (eventSinkClosed || signal.aborted) return;
      events.push(emit(event, data));
      wake?.();
    };
    async function* progress<T>(
      work: Promise<T>,
    ): AsyncGenerator<AgentEvent, T> {
      let settled = false;
      let value: T | undefined;
      let failure: unknown;
      void work.then(
        (v) => {
          value = v;
          settled = true;
          wake?.();
        },
        (e) => {
          failure = e;
          settled = true;
          wake?.();
        },
      );
      while (!settled || events.length) {
        if (events.length) yield events.shift()!;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (settled || events.length) resolve();
          });
      }
      wake = undefined;
      if (failure) throw failure;
      return value!;
    }
    const budget = emptyUsage();
    const usage = budget;
    const environment: WorkerEnvironment = {
      run_id: run.run_id,
      request,
      context,
      personal,
      signal,
      budget,
      traces: run.payload.traces,
      emit: enqueue,
    };
    const turn = (
      messages: AgentMessage[],
      tools: FunctionTool[],
      options: any = {},
    ) => this.runtime.turn(environment, messages, tools, options);
    let citations = new Map<string, AgentCitation>();
    let evidence = new Map<string, string>();
    let readRegions = new Set<string>();
    const coverageRegions = new Set<string>();
    let selectionRead = false;
    let candidateVersion = 0;
    const baseContext = () => this.buildContext(request, context, environment, `initial:${request.request_id}`);
    let base: any;
    const tasks: Record<string, WorkerOutput> = Object.create(null);
    const wikiProofs = new Map<string, WikiProof>();
    let wikiKnowledge: WikiKnowledgeSnapshot | null = null;
    const loop = async (
      step?: ExecutionPlan["steps"][number],
      executionLimit?: number,
      stepTurnLimit?: number,
    ): Promise<AgentResult> => {
      const taskId = step ? randomUUID() : "primary";
      const dependencies = step
        ? Object.fromEntries(step.depends_on.map((id) => [id, tasks[id]!]))
        : tasks;
      const role =
        step?.capability === "read"
          ? "reader"
          : step?.capability === "search"
            ? "researcher"
            : "primary";
      const task = {
        task_id: taskId,
        plan_step_id: step?.id,
        role,
        status: "running",
        usage: emptyUsage(),
        handoff: undefined as
          | {
              coverage: string;
              findings: number;
              missing: number;
              conflicts: number;
            }
          | undefined,
      };
      (run.payload.tasks ??= []).push(task);
      const trace = startAgentSpan(
        { ...environment, task_id: taskId, agent_role: role },
        "worker",
        role,
        { plan_step_id: step?.id ?? "primary" },
      );
      try {
        const output = await this.runtime.runWorker({
          task_id: taskId,
          role,
          environment:
            executionLimit === undefined
              ? { ...environment, parent_span_id: trace.span.span_id }
              : {
                  ...environment,
                  parent_span_id: trace.span.span_id,
                  execution_limit: executionLimit,
                  step_turn_limit: stepTurnLimit,
                },
          base,
          step,
          dependencies,
          usage: task.usage,
        });
        signal.throwIfAborted();
        if (step && output.result.kind !== "answer")
          throw new Error(
            output.result.kind === "clarification"
              ? output.result.question
              : "步骤返回了无效结果",
          );
        output.read_region_ids.forEach((id) => coverageRegions.add(id));
        for (const proof of output.wiki_reads ?? [])
          wikiProofs.set(proof.wiki_id, proof);
        if (step) tasks[step.id] = output;
        else {
          citations = new Map(output.citations.map((c) => [c.id, c]));
          evidence = new Map(output.evidence);
          readRegions = new Set(output.read_region_ids);
          selectionRead = output.selection_read;
        }
        task.status = "succeeded";
        task.usage = output.usage;
        if (output.handoff)
          task.handoff = {
            coverage: output.handoff.coverage,
            findings: output.handoff.findings.length,
            missing: output.handoff.missing.length,
            conflicts: output.handoff.conflicts.length,
          };
        trace.finish();
        return output.result;
      } catch (error) {
        task.status = signal.aborted ? "canceled" : "failed";
        trace.finish(error);
        throw error;
      }
    };
    try {
      await this.audit.begin(run);
    } catch (error) {
      this.active.delete(admissionKey);
      throw error;
    }
    try {
      yield emit("run_started", {
        mode: request.mode,
        output_target: request.output_target,
      });
      base = await withAbort(baseContext(), signal);
      const referenceIds = request.references
        .filter((ref) => ref.kind === "document" && ref.doc_id)
        .map((ref) => ref.doc_id!);
      const wikiScope =
        request.knowledge_scope ??
        (referenceIds.length
          ? {
              private: true,
              public: true,
              team: true,
              document_ids: referenceIds,
            }
          : undefined);
      if (wikiScope) {
        try {
          wikiKnowledge = await withAbort(
            this.wiki.knowledgeSnapshot(wikiScope, context),
            signal,
          );
        } catch {
          // A failed freshness snapshot must not prevent an original-source answer.
          signal.throwIfAborted();
        }
      }
      environment.knowledge_snapshot = wikiKnowledge;
      let route = ruleRoute(request);
      if (!route)
        try {
          const classified = await turn(
            [
              {
                role: "system",
                content:
                  "判断任务为 react 单步或 plan_execute 多步骤。只返回 JSON {strategy,reason}。",
              },
              {
                role: "user",
                content: JSON.stringify({
                  query: request.query,
                  reference_count: request.references.length,
                  has_selection: Boolean(
                    request.editor_snapshot.selection.text,
                  ),
                }),
              },
            ],
            [],
            { role: "classifier", json: true, maxTokens: 300 },
          );
          const value = parseModelJson(classified.content ?? "");
          if (!["react", "plan_execute"].includes(value.strategy))
            throw new Error("分类结果无效");
          route = {
            strategy: value.strategy,
            reason: String(value.reason).slice(0, 200),
            source: "llm",
          };
        } catch {
          route = {
            strategy: "react",
            reason: "分类器不可用，直接执行",
            source: "fallback",
          };
        }
      run.payload.route = route;
      await this.audit.update(run);
      yield emit("route", route);
      let plan = request.confirmed_plan;
      let candidate: AgentResult;
      if (request.mode === "plan") {
        run.status = "planning";
        await this.audit.update(run);
        yield emit("step", { status: "running", description: "生成写作计划" });
        candidate = yield* progress(loop());
      } else {
        if (route.strategy === "plan_execute" && !plan) {
          run.status = "planning";
          await this.audit.update(run);
          yield emit("step", {
            status: "running",
            description: "拆分执行步骤",
          });
          try {
            const message = await turn(
              [
                {
                  role: "system",
                  content:
                    `为文档任务生成不超过${this.supervisor.maxPlanSteps()}步、有无环依赖的执行计划。只返回 JSON {goal,outline,constraints,steps:[{id,description,depends_on,capability:read|search|compose}]}。所有步骤只生成候选，不直接修改正文。请把适用的排版要求写入 constraints。` +
                    writingGuidance,
                },
                { role: "user", content: JSON.stringify(base) },
              ],
              [],
              { role: "plan", json: true },
            );
            plan = validatePlan(parseModelJson(message.content ?? ""));
            this.supervisor.assertPlanFits(plan);
          } catch {
            route = {
              strategy: "react",
              source: "fallback",
              reason: "规划失败，改为直接执行",
            };
            run.payload.route = route;
            yield emit("route", route);
          }
        }
        run.status = "executing";
        await this.audit.update(run);
        let clarification:
          | Extract<AgentResult, { kind: "clarification" }>
          | undefined;
        if (plan) {
          run.payload.plan_summary = planSummary(plan);
          yield emit("plan", { plan });
          base = { ...base, execution_plan: plan };
          run.payload.supervisor = this.supervisor.createTrace();
          await this.audit.update(run);
          const supervisorSpan = startAgentSpan(
            environment,
            "supervisor",
            "supervisor",
          );
          try {
            clarification = yield* progress(
              this.supervisor.run({
                environment: {
                  ...environment,
                  parent_span_id: supervisorSpan.span.span_id,
                  agent_role: "supervisor",
                },
                plan,
                completed: tasks,
                trace: run.payload.supervisor,
                execute: loop,
              }),
            );
            supervisorSpan.finish();
          } catch (error) {
            supervisorSpan.finish(error);
            throw error;
          }
        }
        candidate = clarification ?? (yield* progress(loop()));
      }
      while (events.length) yield events.shift()!;
      const reviewed = await this.reviewCandidate(
        candidate,
        environment,
        base,
        plan,
        citations,
        evidence,
        run,
      );
      candidate = reviewed.candidate;
      if (reviewed.revised) candidateVersion++;
      while (events.length) yield events.shift()!;
      yield* this.finishCandidate({
        candidate,
        candidateVersion,
        request,
        context,
        signal,
        external,
        run,
        citations,
        readRegions,
        coverageRegions,
        selectionRead,
        wikiProofs,
        wikiKnowledge,
        usage,
        budget,
        now,
        emit,
      });
    } catch (error) {
      run.status = external.aborted ? "stopped" : "failed";
      delete run.payload.delivery;
      run.payload.failure = agentFailure(error, signal);
      run.payload.error =
        signal.aborted && !external.aborted
          ? "任务执行超时"
          : error instanceof Error
            ? error.message
            : "任务失败";
      run.payload.usage = { ...usage };
      run.payload.tool_calls = budget.tool_calls;
      run.payload.execution_turns = budget.execution_turns;
      run.payload.duration_ms = Date.now() - now;
      if (this.audit.runs.has(run.run_id))
        await this.audit
          .update(run)
          .catch((e) => console.error("Agent run audit unavailable", e));
      eventSinkClosed = true;
      while (events.length) yield events.shift()!;
      yield emit("error", {
        message: run.payload.error,
        ...run.payload.failure,
      });
      yield emit("done", { status: run.status });
    } finally {
      eventSinkClosed = true;
      this.active.delete(admissionKey);
      if (
        ![
          "awaiting_review",
          "completed",
          "needs_input",
          "failed",
          "stopped",
        ].includes(run.status)
      ) {
        run.status = external.aborted ? "stopped" : "failed";
        delete run.payload.delivery;
        run.payload.failure = {
          code: external.aborted ? "AGENT_STOPPED" : "AGENT_INTERRUPTED",
          retryable: false,
        };
        run.payload.usage = { ...usage };
        await this.audit.update(run);
      }
    }
  }

  async validateGraphSources(
    citations: AgentCitation[],
    proofs: WikiProof[],
    context: AccessContext,
  ) {
    await this.wiki.validateProofs(proofs, context);
    await this.validateCitationSources(citations, context);
  }

  private async validateCitationSources(
    citations: Iterable<Pick<AgentCitation, "kind" | "import_id" | "doc_id" | "version" | "snapshot_hash">>,
    context: AccessContext,
  ) {
    for (const citation of citations) {
      if (citation.import_id) {
        const imported = await this.imports.require(citation.import_id);
        this.imports.assertOwner(imported, context);
        if (citation.kind === 'import' && citation.snapshot_hash &&
          citation.snapshot_hash !== createHash('sha256').update(imported.parsed_content ?? '').digest('hex'))
          throw new ConflictException('导入资料内容已变更，请重新生成');
        if (imported.document_id)
          await this.documents.getAccessible(imported.document_id, context);
      }
      if (citation.doc_id) {
        const doc = await this.documents.getAccessible(
          citation.doc_id,
          context,
        );
        if (
          citation.kind !== "current_document" &&
          citation.version !== undefined &&
          citation.version !== doc.document_version
        )
          throw new ConflictException("参考资料版本已变更，请重新生成");
      }
    }
  }

  async buildContext(request: DocumentAgentDto, context: AccessContext,
    environment?: WorkerEnvironment, inputId = `initial:${request.request_id}`, userText = request.query,
    snapshots: { skill?: WritingSkillSnapshot; preferences?: PreferenceSnapshot; extractPreferences?: boolean } = {}) {
    const constraintState = this.config.conversationConstraintsEnabled && environment
      ? await this.updateConstraints(request, context, environment, inputId, userText)
      : { revision: 0, items: [] };
    const constraintTokens = this.constraints?.tokenCount(constraintState) ?? 0;
    let preferences: PreferenceSnapshot | undefined = snapshots.preferences;
    if (environment?.features?.preferences && this.preferences) {
      if (snapshots.extractPreferences !== false) {
        const prepared = await this.preferences.prepare(context, `${environment.run_id}:${inputId}`, userText,
          (messages) => this.runtime.turn(environment, messages, [], { role: 'classifier', json: true,
            maxTokens: 1600, maxAttempts: 1, trace_name: 'writing_preferences' }), environment.signal);
        preferences ??= prepared.snapshot;
        if (prepared.saved_ids.length || prepared.candidate_ids.length)
          environment.emit('preferences_updated', { saved_ids: prepared.saved_ids, candidate_ids: prepared.candidate_ids,
            revision: prepared.state.revision });
      } else preferences ??= this.preferences.snapshot(await this.preferences.get(context));
    }
    const preferenceTokens = preferences && this.preferences ? this.preferences.tokenCount(preferences) : 0;
    if (preferenceTokens > 500 || constraintTokens + preferenceTokens > this.config.shortMemoryTokenBudget)
      throw new AgentExecutionError('PREFERENCE_CONTEXT_EXCEEDED', '写作要求超过会话容量，请精简长期偏好');
    const identity = request.editor_snapshot.identity;
    const docId = identity.kind === "knowledge" ? identity.doc_id : undefined;
    if (request.skill_id && !environment?.features?.skills)
      throw new BadRequestException('当前任务版本不支持写作 Skill，请使用可恢复任务入口');
    const skill = environment?.features?.skills && this.skills && request.skill_id
      ? snapshots.skill ?? await this.skills.snapshot(context, { ...request, skill_id: request.skill_id }) : undefined;
    return {
      query: request.query,
      plan_step_limit: this.supervisor.maxPlanSteps(),
      output_target: request.output_target,
      allow_web: request.allow_web,
      knowledge_scope: request.knowledge_scope,
      title: request.editor_snapshot.title,
      regions: request.editor_snapshot.regions.slice(0, 100).map((r) => ({
        id: r.id,
        type: r.type,
        heading_path: r.heading_path,
        preview: r.text.slice(0, 80),
      })),
      region_count: request.editor_snapshot.regions.length,
      overview_next_offset:
        request.editor_snapshot.regions.length > 100 ? 100 : null,
      selection: {
        ...request.editor_snapshot.selection,
        text: request.editor_snapshot.selection.text.slice(0, 300),
        region_ids: request.editor_snapshot.selection.region_ids.slice(0, 200),
        text_length: request.editor_snapshot.selection.text.length,
      },
      references: request.references.map(({ content, ...ref }) => ref),
      skill_snapshot: skill,
      template: skill?.template ?? (request.template_id
        ? await this.workspace.getTemplate(context, request.template_id)
        : undefined),
      conversation_constraints: constraintState,
      ...(preferences ? { user_preferences: preferences } : {}),
      conversation_memory: await this.memory.recentText(
        request.conversation_id,
        context,
        agentMemoryDocumentId(identity),
        Math.max(0, this.config.shortMemoryTokenBudget - constraintTokens - preferenceTokens),
      ),
      document_memory: docId
        ? await this.documentMemory.promptText(
            docId,
            identity.kind === "knowledge"
              ? identity.persisted_version
              : undefined,
            request.query,
          )
        : "",
    };
  }

  async skillCatalog(context: AccessContext) {
    return this.skills ? (await this.skills.list(context)).filter((skill) => skill.enabled) : [];
  }

  async selectedSkill(request: DocumentAgentDto, context: AccessContext) {
    return request.skill_id && this.skills ? this.skills.snapshot(context, { ...request, skill_id: request.skill_id }) : undefined;
  }

  skillPlan(snapshot: WritingSkillSnapshot, query: string) {
    if (!this.skills) throw new BadRequestException('写作 Skill 服务不可用');
    return this.skills.toPlan(snapshot, query);
  }

  async updateConstraints(request: DocumentAgentDto, context: AccessContext,
    environment: WorkerEnvironment, inputId: string, userText = request.query) {
    if (!this.constraints) throw new AgentExecutionError('MEMORY_UPDATE_FAILED', '约束记忆服务不可用');
    const turn: ConstraintTurn = (messages) => this.runtime.turn(environment, messages, [], {
      role: 'classifier', json: true, maxTokens: 1600, maxAttempts: 1,
      trace_name: 'conversation_constraints',
    });
    return this.constraints.prepare(request, context, inputId, turn, environment.signal, userText);
  }

  async reviewCandidate(
    candidate: AgentResult,
    environment: WorkerEnvironment,
    base: any,
    plan: ExecutionPlan | undefined,
    citations: Map<string, AgentCitation>,
    evidence: Map<string, string>,
    run: AgentRunRecord,
  ) {
    const { request, signal } = environment;
    const turn = (
      messages: AgentMessage[],
      tools: FunctionTool[],
      options: any = {},
    ) => this.runtime.turn(environment, messages, tools, options);
    let wasRevised = false;
    const needsReflection =
      candidate.kind === "document" ||
      (candidate.kind === "edits" && candidate.edits.length > 1) ||
      (request.deep_thinking && ["answer", "edits"].includes(candidate.kind));
    if (needsReflection) {
      if (!run.payload.workflow_version) {
        run.status = "reflecting";
        await this.audit.update(run);
      }
      environment.emit("reflection", { status: "checking" });
      let rejectedByCritic = false;
      try {
        const critique = await turn(
          [
            {
              role: "system",
              content:
                "检查候选是否满足目标、证据、结构与一致性。仅返回 JSON {passed:boolean,issues:[{type,description}]}，不要输出推理链。" +
                writingGuidance,
            },
            {
              role: "user",
              content: JSON.stringify({
                query: request.query,
                plan,
                candidate,
                citations: [...citations.values()].map(
                  ({ source_content: _source, ...citation }) => citation,
                ),
                evidence_summary: Object.fromEntries(evidence),
                template_constraints: base.template?.instructions,
                skill_acceptance: base.skill_snapshot?.skill.acceptance,
                conversation_constraints: base.conversation_constraints,
                user_preferences: base.user_preferences,
              }),
            },
          ],
          [],
          { role: "critic", json: true, maxTokens: 1000 },
        );
        const verdict = parseModelJson(critique.content ?? "");
        if (
          typeof verdict.passed !== "boolean" ||
          !Array.isArray(verdict.issues) ||
          (!verdict.passed && !verdict.issues.length) ||
          verdict.issues.some(
            (issue: any) =>
              !issue ||
              ![
                "missing_requirement",
                "unsupported_claim",
                "contradiction",
                "structure",
                "style",
              ].includes(issue.type) ||
              typeof issue.description !== "string",
          )
        )
          throw new Error("自检结果无效");
        if (!verdict.passed) {
          rejectedByCritic = true;
          environment.emit("reflection", {
            status: "repairing",
            issues: verdict.issues,
          });
          const repair = await turn(
            [
              {
                role: "system",
                content:
                  "按问题修正候选，保留原结果类型、所有标识和已有引用，只返回修正后的候选 JSON，不调用工具，不引入新图片或事实。" +
                  writingGuidance,
              },
              {
                role: "user",
                content: JSON.stringify({
                  query: request.query,
                  candidate,
                  issues: verdict.issues,
                  conversation_constraints: base.conversation_constraints,
                  user_preferences: base.user_preferences,
                  plan,
                  evidence_summary: Object.fromEntries(evidence),
                }),
              },
            ],
            [],
            { json: true, thinking: request.deep_thinking },
          );
          const revised = parseModelJson(repair.content ?? "");
          validateAgentResult(revised, request, new Set(citations.keys()));
          if (revised.kind !== candidate.kind)
            throw new Error("修正改变了结果类型");
          if (revised.kind === "document")
            revised.document_id = (candidate as any).document_id;
          if (isDeepStrictEqual(revised, candidate))
            throw new Error("修正没有改变已被自检拒绝的候选");
          candidate = revised;
          wasRevised = true;
        }
        run.payload.reflection = {
          status: verdict.passed ? "passed" : "revised",
          issues: verdict.issues,
        };
        environment.emit("reflection", run.payload.reflection);
      } catch (error) {
        if (rejectedByCritic)
          throw new AgentExecutionError(
            "AGENT_REVIEW_FAILED",
            "自检发现的问题未能修复，请调整要求后重新生成",
          );
        run.payload.reflection = {
          status: "incomplete",
          message: "自检未完成，保留候选",
        };
        environment.emit("reflection", run.payload.reflection);
      }
    }

    return { candidate, revised: wasRevised };
  }

  async *finishCandidate(args: {
    candidate: AgentResult;
    candidateVersion: number;
    request: DocumentAgentDto;
    context: AccessContext;
    signal: AbortSignal;
    external: AbortSignal;
    run: AgentRunRecord;
    citations: Map<string, AgentCitation>;
    readRegions: Set<string>;
    coverageRegions: Set<string>;
    selectionRead: boolean;
    wikiProofs: Map<string, WikiProof>;
    wikiKnowledge: WikiKnowledgeSnapshot | null;
    usage: import("./agent-runtime.types.js").AgentUsage;
    budget: import("./agent-runtime.types.js").AgentUsage;
    now: number;
    emit: (event: string, data: Record<string, any>) => AgentEvent;
    saveRun?: (run: AgentRunRecord) => Promise<void>;
  }): AsyncGenerator<AgentEvent> {
    const {
      request,
      context,
      signal,
      external,
      run,
      citations,
      readRegions,
      coverageRegions,
      selectionRead,
      wikiProofs,
      wikiKnowledge,
      usage,
      budget,
      now,
      emit,
      saveRun,
    } = args;
    const { candidate, candidateVersion } = args;
    signal.throwIfAborted();
    // Revalidate permission/deletion after model execution before releasing references.
    await this.wiki.validateProofs(
      [...wikiProofs.values()],
      context,
      wikiKnowledge,
    );
    const identityForAccess = request.editor_snapshot.identity;
    if (identityForAccess.kind === "knowledge")
      await this.documents.getAccessible(identityForAccess.doc_id, context);
    if (identityForAccess.kind === "article")
      await this.articles.requireOwner(identityForAccess.article_id, context);
    await this.validateCitationSources(citations.values(), context);
    validateAgentResult(candidate, request, new Set(citations.keys()));
    if (
      candidate.kind === "answer" &&
      /全文|整篇|总结当前文档/u.test(request.query) &&
      coverageRegions.size < request.editor_snapshot.regions.length
    ) {
      candidate.answer = `资料范围：本回答基于已读取的 ${coverageRegions.size}/${request.editor_snapshot.regions.length} 个正文区域，不是全文结论。\n\n${candidate.answer}`;
    }
    if (candidate.kind === "edits")
      for (const edit of candidate.edits) {
        if (edit.target.kind === "selection") {
          if (!selectionRead) throw new Error("修正后的选区未经读取");
          continue;
        }
        const regions = request.editor_snapshot.regions;
        const ids =
          edit.target.kind === "block_range"
            ? regions
                .slice(
                  regions.findIndex(
                    (r) => r.id === edit.target.first_region_id,
                  ),
                  regions.findIndex(
                    (r) =>
                      r.id ===
                      (edit.target.last_region_id ??
                        edit.target.first_region_id),
                  ) + 1,
                )
                .map((r) => r.id)
            : request.editor_snapshot.selection.region_ids;
        if (ids.some((id) => !readRegions.has(id)))
          throw new Error("修正后的目标区域未经读取");
      }
    if (candidate.kind === "plan") {
      this.supervisor.assertPlanFits(candidate.plan);
      run.payload.plan_summary = planSummary(candidate.plan);
      yield emit("plan", { plan: candidate.plan });
    }
    const text =
      candidate.kind === "answer"
        ? candidate.answer
        : candidate.kind === "document"
          ? candidate.markdown
          : "";
    for (let i = 0; i < text.length; i += 160) {
      signal.throwIfAborted();
      yield emit("delta", {
        text: text.slice(i, i + 160),
        candidate_version: candidateVersion,
      });
    }
    signal.throwIfAborted();
    run.status = ["edits", "document"].includes(candidate.kind)
      ? "awaiting_review"
      : candidate.kind === "clarification"
        ? "needs_input"
        : "completed";
    run.payload.result_kind = candidate.kind;
    run.payload.wiki_reads = [...wikiProofs.values()];
    const selectedCitations = selectAgentCitations(candidate, citations);
    const coverage = {
      read_region_ids: [...coverageRegions],
      unread_region_ids: request.editor_snapshot.regions
        .filter((region) => !coverageRegions.has(region.id))
        .map((region) => region.id),
    };
    run.payload.wiki_origin = await this.wiki.origin(
      candidate,
      selectedCitations,
      request.query,
      context,
      [...wikiProofs.values()],
      wikiKnowledge,
    );
    signal.throwIfAborted();
    run.payload.edit_ids =
      candidate.kind === "edits" ? candidate.edits.map((e) => e.id) : [];
    run.payload.document_id =
      candidate.kind === "document" ? candidate.document_id : undefined;
    run.payload.usage = usage;
    run.payload.tool_calls = budget.tool_calls;
    run.payload.execution_turns = budget.execution_turns;
    run.payload.duration_ms = Date.now() - now;
    run.payload.source_access = [...citations.values()].map(
      ({ kind, doc_id, import_id, version }) => ({
        kind,
        doc_id,
        import_id,
        version,
      }),
    );
    run.payload.delivery = {
      result: structuredClone(candidate),
      citations: selectedCitations,
      candidate_version: candidateVersion,
      selection: request.editor_snapshot.selection,
      ...(candidate.kind === "edits"
        ? {
            region_fingerprints: request.editor_snapshot.regions.map(
              (region) => ({
                id: region.id,
                hash: agentRegionHash(region.original_json),
              }),
            ),
          }
        : {}),
      coverage,
    };
    await (saveRun ? saveRun(run) : this.audit.update(run));
    signal.throwIfAborted();
    const identity = request.editor_snapshot.identity;
    await this.memory.addTurn(
      request.conversation_id,
      request.query,
      `${run.status === "awaiting_review" ? "[候选，尚未应用] " : ""}${JSON.stringify(candidate)}`,
      context,
      agentMemoryDocumentId(identity),
      run.run_id,
    );
    signal.throwIfAborted();
    yield emit("result", {
      result: candidate,
      wiki_available: Boolean(run.payload.wiki_origin),
      citations: selectedCitations,
      candidate_version: candidateVersion,
      coverage,
    });
    yield emit("done", {
      status: run.status,
      usage,
      duration_ms: Date.now() - now,
    });
    if (
      !saveRun &&
      !external.aborted &&
      candidate.kind === "answer" &&
      run.payload.wiki_origin
    )
      this.wiki.enqueueCapture(
        run,
        candidate.answer,
        context,
        [...wikiProofs.values()],
        (state) => this.audit.recordWikiCapture(run.run_id, context, state),
      );
  }

  private async recoverRun(id: string, context: AccessContext) {
    const run = await this.audit.get(id, context);
    if (run.payload.delivery) {
      const identity = run.payload.identity;
      const canRebase =
        run.status === "awaiting_review" &&
        run.payload.delivery.result.kind === "edits" &&
        Array.isArray(run.payload.delivery.region_fingerprints);
      if (identity.kind === "knowledge") {
        const doc = await this.documents.getAccessible(
          identity.doc_id,
          context,
        );
        if (
          !canRebase &&
          !(
            run.payload.workflow_version &&
            run.payload.output_target === "new_document"
          ) &&
          doc.document_version !== identity.persisted_version
        )
          throw new ConflictException("文档版本已更新，请重新生成候选");
      } else if (identity.kind === "article") {
        const article = await this.articles.requireOwner(
          identity.article_id,
          context,
        );
        if (
          !canRebase &&
          !(
            run.payload.workflow_version &&
            run.payload.output_target === "new_document"
          ) &&
          article.draft_version !== identity.draft_version
        )
          throw new ConflictException("文章草稿版本已更新，请重新生成候选");
      } else if (identity.kind === "import") {
        const imported = await this.imports.require(identity.import_id);
        this.imports.assertOwner(imported, context);
        if (imported.document_id)
          await this.documents.getAccessible(imported.document_id, context);
      }
      await this.validateCitationSources(
        run.payload.source_access ?? run.payload.delivery.citations,
        context,
      );
      await this.wiki.validateProofs(run.payload.wiki_reads ?? [], context);
    }
    if (
      !run.payload.workflow_version &&
      ![
        "awaiting_review",
        "completed",
        "needs_input",
        "failed",
        "stopped",
      ].includes(run.status) &&
      !this.audit.isActive(id)
    )
      return { ...run, status: "interrupted" };
    return run;
  }
  async getRun(id: string, context: AccessContext) {
    const run = await this.audit.get(id, context);
    const { delivery: _delivery, ...payload } = run.payload;
    const interrupted =
      !run.payload.workflow_version &&
      ![
        "awaiting_review",
        "completed",
        "needs_input",
        "failed",
        "stopped",
      ].includes(run.status) &&
      !this.audit.isActive(id);
    return {
      ...run,
      payload,
      status: interrupted ? "interrupted" : run.status,
    };
  }
  async restore(
    id: string,
    context: AccessContext,
    editorJson: Record<string, unknown>,
  ) {
    const run = await this.recoverRun(id, context);
    if (
      run.status === "awaiting_review" &&
      run.payload.delivery?.result.kind === "edits" &&
      createHash("sha256").update(JSON.stringify(editorJson)).digest("hex") !==
        run.payload.snapshot_hash
    ) {
      // Return a rebased copy; feedback and stored candidates stay in the original coordinate system.
      return {
        ...run,
        payload: {
          ...run.payload,
          delivery: rebaseAgentDelivery(
            run.payload.delivery,
            run.payload.feedback ?? {},
            editorJson,
          ),
        },
      };
    }
    return run;
  }
  async feedback(
    id: string,
    context: AccessContext,
    input: { action: string; edit_id?: string; document_id?: string },
  ) {
    const work = (this.feedbackWrites.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.recordFeedback(id, context, input));
    this.feedbackWrites.set(id, work);
    try {
      return await work;
    } finally {
      if (this.feedbackWrites.get(id) === work) this.feedbackWrites.delete(id);
    }
  }
  private async recordFeedback(
    id: string,
    context: AccessContext,
    input: { action: string; edit_id?: string; document_id?: string },
  ) {
    const run = await this.audit.get(id, context);
    if (["helpful", "incorrect"].includes(input.action)) {
      if (
        run.status !== "completed" ||
        run.payload.result_kind !== "answer" ||
        input.edit_id ||
        input.document_id
      )
        throw new BadRequestException("只能评价已完成的回答");
      if (
        run.payload.feedback?.answer === "incorrect" &&
        input.action !== "incorrect"
      )
        throw new ConflictException("已标记有误，请重新提问以生成新回答");
      const action = input.action as "helpful" | "incorrect";
      await this.audit.recordAnswerFeedback(id, context, action);
      await this.wiki.answerFeedback(run, context, action);
      return { status: run.status, feedback: action };
    }
    if (
      !["awaiting_review", "completed"].includes(run.status) ||
      !["edits", "document"].includes(run.payload.result_kind)
    )
      throw new BadRequestException("当前任务没有可采纳候选");
    if (
      run.payload.result_kind === "edits" &&
      (!input.edit_id ||
        !["accepted", "rejected", "conflict"].includes(input.action))
    )
      throw new BadRequestException("修改反馈需要具体建议标识");
    if (
      run.payload.result_kind === "document" &&
      (!["created", "discarded"].includes(input.action) || input.edit_id)
    )
      throw new BadRequestException("文稿反馈参数无效");
    if (input.edit_id && !run.payload.edit_ids?.includes(input.edit_id))
      throw new BadRequestException("未知修改建议");
    if (
      input.action === "created" &&
      input.document_id !== run.payload.document_id
    )
      throw new BadRequestException("文稿标识不匹配");
    if (input.action === "created")
      await this.documents.getAccessible(input.document_id!, context);
    const feedback = run.payload.feedback ?? {};
    const previous = feedback[input.edit_id ?? "document"];
    if (
      ["accepted", "rejected", "created", "discarded"].includes(previous) &&
      previous !== input.action
    )
      throw new ConflictException("此候选已经处理，请重新生成新的候选");
    feedback[input.edit_id ?? "document"] = input.action;
    run.payload.feedback = feedback;
    if (
      input.action === "created" ||
      input.action === "discarded" ||
      (run.payload.edit_ids?.length &&
        run.payload.edit_ids.every((e: string) =>
          ["accepted", "rejected"].includes(feedback[e]),
        ))
    )
      run.status = "completed";
    await this.audit.update(run);
    return { status: run.status };
  }
}
