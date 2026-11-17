/**
 * @file Agent 图工作流。用 LangGraph 连接规划、确认、Worker 执行、汇总、核验和恢复节点。
 */
import { Injectable, BadRequestException } from "@nestjs/common";
import {
  Annotation,
  StateGraph,
  START,
  END,
  Send,
  interrupt,
} from "@langchain/langgraph";
import { AppConfig } from "../../config/app-config.js";
import type { AccessContext } from "../../common/types.js";
import { DocumentAgentService, ruleRoute } from "../document-agent.service.js";
import { AgentRuntimeService } from "../agent-runtime.service.js";
import {
  AgentSupervisorService,
  type SupervisorTrace,
  type SupervisorDecision,
} from "../agent-supervisor.service.js";
import { AgentSettingsService } from "../agent-settings.service.js";
import { WikiService } from "../../wiki/wiki.service.js";
import { parseModelJson, selectAgentCitations, validatePlan } from "../document-agent.validation.js";
import { writingGuidance } from "../document-agent-tools.service.js";
import type { DocumentAgentDto } from "../document-agent.dto.js";
import type { ExecutionPlan, AgentResult } from "../document-agent.types.js";
import {
  emptyUsage,
  type WorkerEnvironment,
  type WorkerOutput,
} from "../agent-runtime.types.js";
import {
  AgentRunRepository,
  type GraphRun,
  type RunCommand,
} from "./agent-run.repository.js";
import { MySqlCheckpointSaver } from "./mysql-checkpoint-saver.js";
import {
  agentFailure,
  AgentExecutionError,
  startAgentSpan,
} from "../agent-execution.js";
import { AuthService } from "../../auth/auth.service.js";
import { EvidenceVerificationService, type VerificationReport } from '../evidence-verification.service.js';
import { activeStepOutputs, dependencyClosure, stepArtifactKey, stepFingerprint, type StepOutputs } from '../step-versions.js';
import { ResearchWritingService } from '../research-writing.service.js';
import { contentHash, type ResearchBrief, type ResearchReview } from '../research-writing.js';
import type { WritingSkillSnapshot } from '../writing-skills.types.js';

const GraphState = Annotation.Root({
  base: Annotation<string>(),
  constraintInput: Annotation<{ id: string; text: string; kind?: 'approval' | 'user' } | null>(),
  constraintNext: Annotation<string>(),
  plan: Annotation<ExecutionPlan | null>(),
  needsPlan: Annotation<boolean>(),
  needsKnowledge: Annotation<boolean>(),
  needsApproval: Annotation<boolean>(),
  approved: Annotation<boolean>(),
  planVersion: Annotation<number>(),
  planFeedback: Annotation<string>(),
  steps: Annotation<ExecutionPlan["steps"]>(),
  trace: Annotation<SupervisorTrace>(),
  decision: Annotation<SupervisorDecision | null>(),
  outputs: Annotation<StepOutputs>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  questions: Annotation<
    Record<string, { question: string; choices: string[] } | null>
  >({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  answers: Annotation<Record<string, string>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  failures: Annotation<
    Record<string, { code: string; message: string; retryable: boolean } | null>
  >({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  primary: Annotation<string>(),
  reviewed: Annotation<string>(),
  finalStatus: Annotation<string>(),
  invalidated: Annotation<Record<string, boolean>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  candidateVersion: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  correctionCount: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  verification: Annotation<string>(),
  recoveryInstruction: Annotation<string>(),
  researchBrief: Annotation<string>(),
  researchReview: Annotation<string>(),
});
type State = typeof GraphState.State;

/**
 * 只保留候选采用的证据；编辑候选同时保留当前文档来源。
 *
 * @param output 指定子任务已交付的结果和证据。
 * @returns Agent 引用来源列表。
 */
function candidateEvidence(output: WorkerOutput) {
  const adopted = selectAgentCitations(output.result, new Map(output.citations.map((citation) => [citation.id, citation])));
  const ids = new Set(adopted.map((citation) => citation.id));
  if (output.result.kind === 'edits' || !ids.size)
    output.citations.filter((citation) => citation.kind === 'current_document').forEach((citation) => ids.add(citation.id));
  return { citations: output.citations.filter((citation) => ids.has(citation.id)),
    evidence: output.evidence.filter(([id]) => ids.has(id)) };
}

/**
 * 从任务上下文提取会话约束、个人偏好、模板与技能要求。
 *
 * @param context 当前操作的上下文。
 * @returns 整理后的状态与操作结果对象。
 */
function writingConstraints(context: Record<string, any>) {
  return { conversation_constraints: context.conversation_constraints, user_preferences: context.user_preferences,
    template_instructions: context.template?.instructions, skill_acceptance: context.skill_snapshot?.skill.acceptance };
}

/**
 * 为旧版检查点补出约束处理后的继续节点。
 *
 *  Checkpoints written before constraint state existed still have the original continuation.
 *
 * @param state 待校验或执行的任务计划。
 * @returns 整理后的文本或标识。
 */
export function constraintContinuation(state: {
  constraintNext?: string;
  questions?: Record<string, unknown>;
  needsApproval?: boolean;
  approved?: boolean;
  plan?: ExecutionPlan | null;
}): string {
  if (state.constraintNext) return state.constraintNext;
  if (Object.values(state.questions ?? {}).some(Boolean)) return 'clarify';
  if (state.needsApproval && !state.approved) return 'make_plan';
  return state.plan ? 'decide_next' : 'compose';
}

/**
 * 判断本次请求是否要求先展示计划并等待用户确认。
 *
 * @param request 包含写作需求、编辑器快照和参考资料的 Agent 请求。
 * @returns 条件是否满足的判断结果。
 */
export function needsPlanApproval(request: DocumentAgentDto) {
  return (
    request.mode === "plan" ||
    (!request.confirmed_plan &&
      request.mode === "agent" &&
      /先.{0,12}(?:给|看|生成|列|出).{0,8}(?:大纲|计划)|确认.{0,6}(?:后|再).{0,6}(?:写|生成|执行)/u.test(
        request.query,
      ))
  );
}

@Injectable()
export class AgentGraphWorkflow {
  private readonly verification = new EvidenceVerificationService();
  private readonly research = new ResearchWritingService();
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param repository AgentRunRepository 依赖实例。
   * @param document 当前知识文档记录。
   * @param runtime AgentRuntimeService 依赖实例。
   * @param supervisor AgentSupervisorService 依赖实例。
   * @param settings AgentSettingsService 依赖实例。
   * @param wiki WikiService 依赖实例。
   * @param config 应用运行配置。
   * @param auth AuthService 依赖实例。
   */
  constructor(
    private readonly repository: AgentRunRepository,
    private readonly document: DocumentAgentService,
    private readonly runtime: AgentRuntimeService,
    private readonly supervisor: AgentSupervisorService,
    private readonly settings: AgentSettingsService,
    private readonly wiki: WikiService,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {}

  /**
   * 构建并编译当前运行对应的 LangGraph 节点、路由和检查点存储。
   *
   * @param run 当前 Agent 运行记录。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param signal 取消信号，用于中止请求和后台处理。
   * @returns 供后续操作使用的回调或清理函数；未找到或不可用时可能为空。
   */
  async build(run: GraphRun, context: AccessContext, signal: AbortSignal) {
    const repo = this.repository,
      generation = run.execution_generation,
      id = run.run_id;
    const request = await repo.artifact<DocumentAgentDto>(id, "input");
    const v2 = run.graph_version === 'v2';
    const research = v2 && run.payload.policy?.research_writing === true;
    const researchSkill = research ? await repo.artifact<WritingSkillSnapshot>(id, 'selected_skill') : undefined;
    const personal = await this.settings.runtime(context);
    const budget = run.budget;
    let events: Promise<void> = Promise.resolve();
    /**
     * 按顺序持久化节点事件，供前端通过游标读取。
     *
     * @param event 需要处理的事件。
     * @param data 当前事件或操作携带的数据。
     */
    const emit = (event: string, data: Record<string, any>) => {
      if (event === "done") return;
      events = events.then(() => repo.event(id, generation, event, data));
      // The node barrier below propagates this error before any following checkpoint.
      void events.catch(() => undefined);
    };
    /**
     * 从持久化任务恢复 Worker 的身份、配置、预算和事件出口。
     *
     * @param state 当前业务或插件状态。
     * @param primary 负责最终整合与交付的主 Agent 状态。
     * @returns Worker 执行环境。
     */
    const environment = (state: State, primary = false): WorkerEnvironment => ({
      run_id: id,
      request: {
        ...request,
        mode:
          state.approved && request.mode === "plan" ? "agent" : request.mode,
        ...(state.plan && state.approved ? { confirmed_plan: state.plan } : {}),
        query:
          request.query +
          Object.entries(state.answers ?? {})
            .map(([key, text]) => `\n用户对 ${key} 的补充：${text}`)
            .join(""),
      },
      context,
      personal,
      signal,
      budget,
      traces: run.payload.traces,
      parent_span_id: (state as any).__span_id,
      ...(primary ? { task_id: "primary" } : {}),
      researchManaged: Boolean(state.plan),
      features: v2 ? run.payload.policy : undefined,
      emit,
      ledger: {
        increment: async (counter, limit) => {
          Object.assign(
            budget,
            await repo.increment(id, generation, counter, limit),
          );
        },
        reserve: async (prompt, max, limits, reserve) => {
          const r = await repo.reserve(
            id,
            generation,
            prompt,
            max,
            limits,
            reserve,
          );
          Object.assign(budget, r.budget);
          return async (actual) => {
            Object.assign(budget, await repo.settle(id, r.reservation, actual));
          };
        },
      },
    });
    /**
     * 从产物存储读取指定步骤的 Worker 输出。
     *
     * @param key 查询或存储使用的键。
     * @returns 子任务结果、用量与证据。
     */
    const output = async (key: string) => {
      const value = await repo.artifact<WorkerOutput>(id, key);
      await this.document.validateGraphSources(
        value.citations,
        value.wiki_reads ?? [],
        context,
      );
      return value;
    };
    /**
     * 收集当前计划中已完成且版本有效的步骤结果。
     *
     * @param state 当前业务或插件状态。
     * @returns 子任务结果、用量与证据。
     */
    const completed = async (
      state: State,
    ): Promise<Record<string, WorkerOutput>> =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(v2 ? activeStepOutputs(state.steps, state.outputs,
            Object.keys(state.invalidated ?? {}).filter((key) => state.invalidated[key]), state.base) : state.outputs).map(async ([key, ref]) => [
            key,
            await output(typeof ref === 'string' ? ref : ref.artifact_key),
          ]),
        ),
      );
    /**
     * 读取图任务保存的基础上下文。
     *
     * @param state 当前业务或插件状态。
     * @returns any 类型的处理结果。
     */
    const base = (state: State) => repo.artifact<any>(id, state.base);
    /**
     * 为图节点统一附加执行追踪和错误收尾。
     *
     * @param name 目标名称。
     * @param work 需要在受控上下文中执行的异步操作。
     * @returns 供后续操作使用的回调或清理函数。
     */
    const wrap =
      (name: string, work: (state: any) => Promise<any>) =>
      async (state: any) => {
        signal.throwIfAborted();
        const current = await this.auth.identityByUserId(run.user_id);
        if (!current || current.space_id !== run.space_id)
          throw new AgentExecutionError("ACCESS_DENIED", "用户访问身份已失效");
        Object.assign(context, current);
        await repo.stage(id, generation, name);
        const span = startAgentSpan(environment(state), "worker", name);
        try {
          const result = await work({ ...state, __span_id: span.span.span_id });
          await events;
          signal.throwIfAborted();
          const failure = Object.values(result?.failures ?? {}).find(
            Boolean,
          ) as { code: string; message: string } | undefined;
          span.finish(
            failure
              ? new AgentExecutionError(failure.code, failure.message)
              : undefined,
          );
          return result;
        } catch (error) {
          span.finish(error);
          throw error;
        } finally {
          await repo.recordTraces(id, generation, run.payload.traces);
        }
      };
    /**
     * 运行计划中指定角色的步骤，并保存该步骤的产物。
     *
     * @param state 当前业务或插件状态。
     * @param step 待校验或执行的任务计划（可选）。
     * @param executionLimit 当前步骤允许使用的执行额度（可选）。
     * @param stepTurnLimit 当前步骤允许进行的模型轮次数（可选）。
     * @returns 子任务结果、用量与证据。
     */
    const worker = async (
      state: State,
      step?: ExecutionPlan["steps"][number],
      executionLimit?: number,
      stepTurnLimit?: number,
    ) => {
      const b = await base(state),
        dependencies = await completed(state);
      const env = environment(state, !step);
      if (research && state.researchBrief) env.research_brief = await repo.artifact<ResearchBrief>(id, state.researchBrief);
      env.knowledge_snapshot = b.knowledge_snapshot;
      const value = await this.runtime.runWorker({
        task_id: step?.id ?? "primary",
        role:
          step?.capability === "read"
            ? "reader"
            : step?.capability === "search"
              ? "researcher"
              : "primary",
        environment: {
          ...env,
          execution_limit: executionLimit,
          step_turn_limit: stepTurnLimit,
        },
        base: {
          ...b.context,
          query: env.request.query,
          clarification_answers: state.answers,
          ...(v2 && state.recoveryInstruction ? { recovery_instruction: state.recoveryInstruction } : {}),
          ...(state.plan ? { execution_plan: state.plan } : {}),
          ...(env.research_brief ? { research_brief: env.research_brief } : {}),
        },
        step,
        dependencies: step
          ? Object.fromEntries(
              step.depends_on.map((key) => [key, dependencies[key]!]),
            )
          : dependencies,
      });
      return value;
    };
    const builder = new StateGraph(GraphState)
      .addNode(
        "prepare",
        wrap("prepare", async () => {
          await this.document.validateIdentity(
            request,
            context,
            personal,
            true,
          );
          const contextData = await this.document.buildContext(
            request,
            context,
            environment({ answers: {}, approved: false } as State),
            `initial:${request.request_id}`,
            request.query,
            { skill: v2 && run.payload.policy.skills && request.skill_id
              ? await repo.artifact(id, 'selected_skill') : undefined },
          );
          const knowledge_snapshot = request.knowledge_scope
            ? await this.wiki
                .knowledgeSnapshot(request.knowledge_scope, context)
                .catch(() => null)
            : null;
          await repo.saveArtifact(id, generation, "base", {
            context: contextData,
            knowledge_snapshot,
          });
          const approval = needsPlanApproval(request);
          let route = ruleRoute(request);
          const skillCatalog = v2 && run.payload.policy.skills && !request.skill_id
            ? await this.document.skillCatalog(context) : [];
          const explicitKnowledge =
            /知识库|资料库|文献|参考资料|选中资料/u.test(request.query);
          const localEdit =
            Boolean(request.editor_snapshot.selection.text) &&
            /改写|润色|纠错|摘要|简化/u.test(request.query) &&
            !explicitKnowledge;
          let needsKnowledge =
            Boolean(request.knowledge_scope) && explicitKnowledge;
          if (
            !route ||
            (request.knowledge_scope && !explicitKnowledge && !localEdit)
          ) {
            try {
              const response = await this.runtime.turn(
                environment({ answers: {}, approved: false } as State),
                [
                  {
                    role: "system",
                    content:
                      "判断任务为 react 单步或 plan_execute 多步骤，并判断是否需要检索用户选定的知识库。局部润色、问候及无关问题不需要检索；相关事实查询需要。只返回 JSON {strategy,reason,needs_knowledge:boolean,skill_suggestions?:string[]}。skill_suggestions仅可从skill_catalog选择适用ID，最多3个，用于向用户建议。",
                  },
                  {
                    role: "user",
                    content: JSON.stringify({
                      query: request.query,
                      reference_count: request.references.length,
                      ...(skillCatalog.length ? { skill_catalog: skillCatalog } : {}),
                      knowledge_scope_selected: Boolean(
                        request.knowledge_scope,
                      ),
                    }),
                  },
                ],
                [],
                { role: "classifier", json: true, maxTokens: 300 },
              );
              const value = parseModelJson(response.content ?? "");
              if (Array.isArray(value.skill_suggestions)) {
                const suggested = skillCatalog.filter((skill) => value.skill_suggestions.includes(skill.skill_id)).slice(0, 3);
                if (suggested.length) emit('skill_suggestions', { skills: suggested });
              }
              if (!["react", "plan_execute"].includes(value.strategy))
                throw new Error("无效路由");
              route ??= {
                strategy: value.strategy,
                source: "llm",
                reason: String(value.reason),
              };
              if (
                request.knowledge_scope &&
                typeof value.needs_knowledge === "boolean"
              )
                needsKnowledge = value.needs_knowledge;
            } catch (e) {
              signal.throwIfAborted();
              if ((e as any).code === "AGENT_BUDGET_EXCEEDED") throw e;
            }
          }
          route ??= {
            strategy: "react",
            source: "fallback",
            reason: "直接执行",
          };
          emit("route", route);
          return {
            base: "base",
            needsApproval: approval,
            needsKnowledge,
            approved: !approval,
            planVersion: 0,
            planFeedback: "",
            needsPlan:
              approval || route.strategy === "plan_execute" || needsKnowledge || Boolean(contextData.skill_snapshot),
            plan: request.confirmed_plan ?? null,
            steps: request.confirmed_plan?.steps ?? [],
            trace: this.supervisor.createTrace(),
          };
        }),
      )
      .addNode(
        "make_plan",
        wrap("make_plan", async (state: State) => {
          let plan: ExecutionPlan;
          const selectedSkill = (await base(state)).context.skill_snapshot;
          if (selectedSkill && !state.planFeedback) {
            plan = this.document.skillPlan(selectedSkill, environment(state).request.query);
          } else if (
            request.mode === "ask" &&
            state.needsKnowledge &&
            !state.needsApproval
          ) {
            plan = {
              goal: request.query,
              outline: [],
              constraints: [],
              steps: [
                {
                  id: "research",
                  capability: "search",
                  description: `分析问题中的比较项和待回答项，在授权范围获取证据。${request.query}`,
                  depends_on: [],
                },
              ],
            };
          } else {
            const response = await this.runtime.turn(
              environment(state),
              [
                {
                  role: "system",
                  content:
                    `为任务生成最多${this.supervisor.maxPlanSteps()}步的无环计划。仅返回 JSON {goal,outline:[],constraints:[],steps:[{id,description,depends_on:[],capability:"read"|"search"|"compose"}]}。步骤 id 和 depends_on 元素必须是字符串，例如 "read" 和 ["read"]。等待确认由系统处理，不列为执行步骤。简单选区改写只需读取及改写两步。不扩大知识库或联网范围。` +
                    writingGuidance,
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    ...(await base(state)).context,
                    feedback: state.planFeedback,
                    previous_plan: state.plan,
                  }),
                },
              ],
              [],
              { role: "plan", json: true },
            );
            plan = validatePlan(parseModelJson(response.content ?? ""));
          }
          this.supervisor.assertPlanFits(plan);
          emit("plan", { plan, plan_version: state.planVersion + 1 });
          return {
            plan,
            steps: plan.steps,
            planVersion: state.planVersion + 1,
          };
        }),
      )
      // Keep interrupt outside generic catches; resuming reruns only this side-effect-free node.
      .addNode("review_plan", (state: State) => {
        const command = interrupt({
          type: "plan",
          plan: state.plan,
          plan_version: state.planVersion,
        }) as RunCommand;
        if (command.action === "revise_plan")
          return { approved: false, planFeedback: command.text ?? "",
            constraintInput: { id: `resume:${command.request_id}`, text: command.text ?? "" },
            constraintNext: 'make_plan' };
        if (command.action !== "approve_plan")
          throw new BadRequestException("需要确认计划");
        const plan = command.plan ? validatePlan(command.plan) : state.plan!;
        this.supervisor.assertPlanFits(plan);
        return { plan, steps: plan.steps, approved: true,
          constraintInput: { id: `resume:${command.request_id}`, kind: 'approval',
            text: JSON.stringify({ user_approved_goal: plan.goal, user_approved_constraints: plan.constraints }) },
          constraintNext: 'decide_next' };
      })
      .addNode(
        "decide_next",
        wrap("decide_next", async (state: State) => {
          const done = await completed(state),
            pending = new Set(
              state.steps.filter((s) => !done[s.id]).map((s) => s.id),
            );
          const ready = state.steps.filter(
            (s) => pending.has(s.id) && s.depends_on.every((key) => done[key]),
          );
          if (pending.size && !ready.length)
            throw new BadRequestException("无法满足计划依赖");
          const trace = structuredClone(state.trace);
          const decision = await this.supervisor.decide(
            {
              environment: environment(state),
              plan: state.plan!,
              completed: done,
              trace,
              execute: async () => {
                throw new Error("图节点负责步骤执行");
              },
            },
            state.steps,
            pending,
            ready,
          );
          if (decision.action === "supplement") {
            let supplementId = "supplement";
            while (state.steps.some((step) => step.id === supplementId))
              supplementId += "_";
            const step = {
              id: supplementId,
              capability: "search" as const,
              description: decision.instruction,
              depends_on: decision.depends_on,
            };
            trace.supplement_count++;
            return {
              trace,
              steps: [...state.steps, step],
              decision: { action: "dispatch", task_ids: [step.id] },
            };
          }
          if (decision.action === "clarify")
            return {
              trace,
              decision,
              questions: {
                supervisor: {
                  question: decision.question,
                  choices: decision.choices,
                },
              },
            };
          return { trace, decision };
        }),
      )
      .addNode(
        "execute_step",
        wrap("execute_step", async (state: State & { stepId: string }) => {
          const step = state.steps.find((s) => s.id === state.stepId)!;
          const remaining = state.steps.filter(
            (s) => !Object.hasOwn(v2 ? activeStepOutputs(state.steps, state.outputs,
              Object.keys(state.invalidated ?? {}).filter((key) => state.invalidated[key]), state.base) : state.outputs, s.id),
          ).length;
          const size =
            state.decision?.action === "dispatch"
              ? state.decision.task_ids.length
              : 1;
          const repairReserve = state.trace.repair_count === 0 ? 1 : 0;
          const limit =
            this.config.agentMaxToolCalls -
            3 -
            repairReserve -
            3 * (remaining - size);
          const turns = Math.min(
            research && step.capability === 'search' ? 8 : 4,
            Math.floor((limit - budget.execution_turns) / size),
          );
          if (turns < 1) throw new BadRequestException("剩余执行预算不足");
          emit("step", {
            id: step.id,
            description: step.description,
            status: "running",
          });
          let result: WorkerOutput;
          try {
            result = await worker(state, step, limit, turns);
          } catch (error) {
            signal.throwIfAborted();
            const failure = agentFailure(error);
            emit("step", {
              id: step.id,
              description: step.description,
              status: "failed",
            });
            return {
              failures: {
                [step.id]: {
                  ...failure,
                  message:
                    error instanceof Error ? error.message : "步骤执行失败",
                },
              },
            };
          }
          if (result.result.kind === "clarification")
            return { questions: { [step.id]: result.result } };
          if (result.result.kind !== "answer")
            throw new BadRequestException("步骤交付类型无效");
          const previousOutput = Object.hasOwn(state.outputs, step.id) ? state.outputs[step.id] : undefined;
          const version = typeof previousOutput === 'object' ? previousOutput.version + 1 : 1;
          const key = v2 ? stepArtifactKey(step.id, version) : `step:${step.id}`;
          await repo.saveArtifact(id, generation, key, result);
          emit("step", {
            id: step.id,
            description: step.description,
            status: "done",
          });
          return { outputs: { [step.id]: v2 ? {
            artifact_key: key, version,
            input_fingerprint: stepFingerprint(step, activeStepOutputs(state.steps, state.outputs,
              Object.keys(state.invalidated ?? {}).filter((item) => state.invalidated[item])), state.base),
          } : key }, ...(v2 ? { invalidated: { [step.id]: false } } : {}) };
        }),
      )
      .addNode("after_batch", (state: State) => {
        const failures = Object.entries(state.failures).filter(
          ([, value]) => value,
        );
        const fatal = failures.find(([, value]) => !value!.retryable);
        if (fatal)
          throw new AgentExecutionError(fatal[1]!.code, fatal[1]!.message);
        if (failures.length) {
          // Barrier: all sibling writes are checkpointed before asking to retry failed steps.
          const command = interrupt({
            type: "retry",
            failures: failures.map(([step_id, error]) => ({
              step_id,
              ...error,
            })),
          }) as RunCommand;
          if (command.action !== "continue")
            throw new BadRequestException("请继续原任务");
          return {
            failures: Object.fromEntries(failures.map(([key]) => [key, null])),
          };
        }
        return {};
      })
      .addNode("clarify", (state: State) => {
        const [key, question] = Object.entries(state.questions).find(
          ([, value]) => value,
        )!;
        const command = interrupt({
          type: "clarification",
          ...question,
        }) as RunCommand;
        if (command.action !== "answer" || !command.text?.trim())
          throw new BadRequestException("请补充回答");
        return { questions: { [key]: null }, answers: { [key]: command.text },
          constraintInput: { id: `resume:${command.request_id}`, text: command.text },
          constraintNext: Object.entries(state.questions).some(([id, value]) => id !== key && value)
            ? 'clarify' : state.plan ? 'decide_next' : 'compose' };
      })
      .addNode('update_constraints', wrap('update_constraints', async (state: State) => {
        if (!state.constraintInput) return {};
        const previous = await base(state);
        const value = await this.document.buildContext(request, context, environment(state),
          state.constraintInput.id, state.constraintInput.text, { skill: previous.context.skill_snapshot,
            preferences: previous.context.user_preferences, extractPreferences: state.constraintInput.kind !== 'approval' });
        const key = `base:${state.constraintInput.id}`;
        await repo.saveArtifact(id, generation, key, { ...previous, context: value });
        return { base: key, constraintInput: null };
      }))
      .addNode(
        "compose",
        wrap("compose", async (state: State) => {
          let result = await worker(state);
          if (result.result.kind === "clarification")
            return { questions: { primary: result.result } };
          if (research) {
            const dependencies = await completed(state);
            const notes = Object.entries(dependencies).flatMap(([task_id, output]) => (output.research_notes ?? []).map(note => ({ ...note, task_id })));
            const source_keys = Object.values(activeStepOutputs(state.steps, state.outputs,
              Object.keys(state.invalidated ?? {}).filter(key => state.invalidated[key]), state.base));
            const noteArtifact = { notes, source_keys };
            const notesKey = `research:notes:${contentHash(noteArtifact)}`;
            await repo.saveArtifact(id, generation, notesKey, noteArtifact);
            await repo.saveDelivery(id, generation, { research_notes_key: notesKey });
            result = await this.research.chapters({ request: environment(state, true).request, skill: researchSkill!,
              brief: await repo.artifact<ResearchBrief>(id, state.researchBrief), candidate: result,
              turn: (messages, options) => this.runtime.turn(options.trace_name === 'research_section'
                ? { ...environment(state, true), task_id: 'research_writer' } : environment(state, true), messages, [], options),
              preview: (evidence, goal) => this.runtime.evidencePreview(evidence, goal),
              load: key => repo.optionalArtifact(id, key), save: (key, value) => repo.saveArtifact(id, generation, key, value), emit, signal });
          }
          const key = v2 ? `primary:v2:${state.candidateVersion}` : `primary:${run.execution_generation}`;
          await repo.saveArtifact(id, generation, key, result);
          return { primary: key };
        }),
      )
      .addNode(
        "review_candidate",
        wrap("review_candidate", async (state: State) => {
          const result = await output(state.primary),
            b = await base(state);
          const observed = v2 ? candidateEvidence(result) : result;
          if (research) {
            const report = await this.research.review(await repo.artifact<ResearchBrief>(id, state.researchBrief), result,
              await completed(state), state.candidateVersion, !state.correctionCount && !state.trace.supplement_count && state.steps.length < this.supervisor.maxPlanSteps(),
              (messages, options) => this.runtime.turn(environment(state, true), messages, [], options));
            const reportKey = `research:coverage:${state.candidateVersion}`;
            await repo.saveArtifact(id, generation, reportKey, { ...report, source_keys: [state.primary,
              ...Object.values(activeStepOutputs(state.steps, state.outputs,
                Object.keys(state.invalidated ?? {}).filter(key => state.invalidated[key]), state.base))] });
            await repo.saveDelivery(id, generation, { research_coverage_key: reportKey,
              research_completeness: report.completeness });
            emit('research_coverage', { ...report, items: report.items, status: report.deliverable ? report.completeness : 'repairing' });
            const key = `reviewed:v2:${state.candidateVersion}`;
            await repo.saveArtifact(id, generation, key, { ...result, candidate_version: state.candidateVersion });
            return { reviewed: key, researchReview: reportKey };
          }
          const review = await this.document.reviewCandidate(
            result.result,
            environment(state, true),
            b.context,
            state.plan ?? undefined,
            new Map(observed.citations.map((c) => [c.id, c])),
            new Map(observed.evidence),
            run,
          );
          const key = v2 ? `reviewed:v2:${state.candidateVersion}` : `reviewed:${run.execution_generation}`;
          await repo.saveArtifact(id, generation, key, {
            ...result,
            result: review.candidate,
            reflection: run.payload.reflection,
            candidate_version: v2 ? state.candidateVersion : review.revised ? 1 : 0,
          });
          return { reviewed: key };
        }),
      )
      .addNode(
        "deliver",
        wrap("deliver", async (state: State) => {
          const result = await repo.artifact<
            WorkerOutput & { reflection: unknown; candidate_version: number }
          >(id, state.reviewed);
          const dependencies = await completed(state),
            b = await base(state);
          const all = [...Object.values(dependencies), result];
          const proofs = new Map(
            all.flatMap((o) => o.wiki_reads ?? []).map((p) => [p.wiki_id, p]),
          );
          run.payload.reflection = result.reflection;
          run.payload.supervisor = state.trace;
          const effective = environment(state, true).request;
          for await (const event of this.document.finishCandidate({
            candidate: result.result,
            candidateVersion: result.candidate_version,
            request: effective,
            context,
            signal,
            external: signal,
            run,
            citations: new Map(result.citations.map((c) => [c.id, c])),
            readRegions: new Set(result.read_region_ids),
            coverageRegions: new Set(all.flatMap((o) => o.read_region_ids)),
            selectionRead: result.selection_read,
            wikiProofs: proofs,
            wikiKnowledge: b.knowledge_snapshot,
            usage: budget,
            budget,
            now: Date.now() - run.active_ms,
            emit: (event, data) => ({
              event,
              data: { ...data, run_id: id, seq: 0 },
            }),
            saveRun: async (record) => {
              await repo.saveDelivery(id, generation, record.payload);
            },
          }))
            emit(event.event, event.data);
          return { finalStatus: run.status };
        }),
      )
      .addEdge(START, "prepare")
      .addConditionalEdges("prepare", (s) =>
        s.plan
          ? s.needsApproval && !s.approved
            ? "review_plan"
              : research ? 'research_brief' : "decide_next"
          : s.needsPlan
            ? "make_plan"
            : "compose",
      )
      .addConditionalEdges("make_plan", (s) =>
        research ? 'research_brief' : s.needsApproval && !s.approved ? "review_plan" : "decide_next",
      )
      .addEdge('review_plan', 'update_constraints')
      .addConditionalEdges('update_constraints', s => research && constraintContinuation(s) === 'decide_next' ? 'research_brief' : constraintContinuation(s))
      .addConditionalEdges("decide_next", (s) =>
        s.decision?.action === "dispatch"
          ? s.decision.task_ids.map(
              (stepId) => new Send("execute_step", { ...s, stepId }),
            )
          : s.decision?.action === "clarify"
            ? "clarify"
            : "compose",
      )
      .addEdge("execute_step", "after_batch")
      .addConditionalEdges("after_batch", (s) =>
        Object.values(s.questions).some(Boolean) ? "clarify" : "decide_next",
      )
      .addEdge('clarify', 'update_constraints')
      .addConditionalEdges("compose", (s) =>
        Object.values(s.questions).some(Boolean)
          ? "clarify"
          : "review_candidate",
      )
      .addEdge("deliver", END);
    if (v2) {
      if (research) builder.addNode('research_brief', wrap('research_brief', async (state: State) => {
        const effective = environment(state).request, b = await base(state);
        const fingerprint = contentHash({ plan: state.plan, query: effective.query, constraints: writingConstraints(b.context), skill: researchSkill });
        const key = `research:brief:${fingerprint}`;
        let brief = await repo.optionalArtifact<ResearchBrief>(id, key);
        if (!brief) {
          brief = await this.research.brief(effective, state.plan!, researchSkill!,
            (messages, options) => this.runtime.turn(environment(state), messages, [], options));
          await repo.saveArtifact(id, generation, key, brief);
        }
        await repo.saveDelivery(id, generation, { research_brief_key: key, research_workflow: true });
        emit('research_brief', { brief });
        return { researchBrief: key };
      })).addConditionalEdges('research_brief', s => s.needsApproval && !s.approved ? 'review_plan' : 'decide_next');
      builder.addNode('verify_evidence', wrap('verify_evidence', async (state: State) => {
        const candidate = await output(state.reviewed), b = await base(state);
        const observed = candidateEvidence(candidate);
        const dependencies = await completed(state);
        emit('verification', { status: state.correctionCount ? 'rechecking' : 'checking', candidate_version: state.candidateVersion });
        const report = await this.verification.verify({
          ...(research ? { batch_chars: 2400 } : {}),
          candidate: candidate.result, candidate_version: state.candidateVersion,
          request: environment(state).request, plan: state.plan ?? undefined,
          constraints: writingConstraints(b.context), citations: observed.citations, evidence: observed.evidence,
          step_evidence: Object.fromEntries(Object.entries(dependencies).map(([key, value]) => [key, value.citations.map((citation) => citation.id)])),
          step_findings: Object.fromEntries(Object.entries(dependencies).map(([key, value]) => [key, value.handoff])),
          signal,
        }, (messages, options) => this.runtime.turn(environment(state, true), messages, [], options)).catch(async (error) => {
          emit('verification', { status: 'incomplete', candidate_version: state.candidateVersion,
            message: error instanceof Error ? error.message : '证据核验未完成' });
          await events;
          throw error;
        });
        if (research && state.researchReview) {
          const coverage = await repo.artifact<ResearchReview>(id, state.researchReview);
          if (report.passed && !coverage.deliverable) {
            report.passed = false;
            report.recovery = { action: coverage.recovery.action === 'none' ? 'repair' : coverage.recovery.action,
              claim_ids: [], step_ids: [], instruction: coverage.recovery.instruction || '补全未覆盖问题或明确说明资料不足。',
              ...(coverage.recovery.question ? { question: coverage.recovery.question } : {}) };
          }
        }
        const key = `verification:${state.candidateVersion}`;
        await repo.saveArtifact(id, generation, key, report);
        await repo.saveDelivery(id, generation, { verification: { candidate_version: report.candidate_version,
          passed: report.passed, claim_count: report.claims.length, action: report.recovery.action } });
        emit('verification', { status: report.passed ? 'passed' : 'repairing', candidate_version: state.candidateVersion,
          issues: report.claims.filter((claim) => claim.status !== 'supported').map((claim) => ({ type: claim.status, description: claim.reason })) });
        return { verification: key };
      }))
      .addNode('recover_candidate', wrap('recover_candidate', async (state: State) => {
        const report = await repo.artifact<VerificationReport>(id, state.verification);
        if (state.correctionCount >= 1)
          throw new AgentExecutionError('AGENT_REVIEW_FAILED', '证据问题在一次纠错后仍未通过核验，请调整要求');
        const candidateVersion = state.candidateVersion + 1;
        const common = { correctionCount: 1, candidateVersion, recoveryInstruction: report.recovery.instruction };
        if (report.recovery.action === 'clarify') return { ...common,
          questions: { verification: { question: report.recovery.question || report.recovery.instruction, choices: [] } } };
        if (research && (['none', 'repair'].includes(report.recovery.action) || report.recovery.action === 'research' &&
          (state.trace.supplement_count || state.steps.length >= this.supervisor.maxPlanSteps()))) {
          if (report.recovery.action === 'research') {
            report.recovery.action = 'repair';
            report.recovery.instruction += ' 补查额度已使用，仅根据现有证据修订并逐项说明仍缺资料的部分。';
          }
          const candidate = await output(state.reviewed);
          const revised = await this.research.repair(environment(state, true).request,
            await repo.artifact<ResearchBrief>(id, state.researchBrief), candidate,
            { evidence: report, coverage: await repo.artifact(id, state.researchReview) },
            (messages, options) => this.runtime.turn(environment(state, true), messages, [], options));
          const key = `primary:v2:${candidateVersion}`;
          await repo.saveArtifact(id, generation, key, { ...candidate, result: revised });
          const reportKey = `${state.verification}:repair`;
          await repo.saveArtifact(id, generation, reportKey, report);
          return { ...common, primary: key, verification: reportKey };
        }
        if (report.recovery.action === 'repair' || report.recovery.action === 'none') {
          const candidate = await output(state.reviewed), b = await base(state);
          const observed = candidateEvidence(candidate);
          const revised = await this.verification.repair({ candidate: candidate.result,
            candidate_version: state.candidateVersion, request: environment(state).request,
            plan: state.plan ?? undefined, constraints: writingConstraints(b.context),
            citations: observed.citations, evidence: observed.evidence, signal,
          }, report, (messages, options) => this.runtime.turn(environment(state, true), messages, [], options)).catch(async (error) => {
            emit('verification', { status: 'incomplete', candidate_version: state.candidateVersion,
              message: error instanceof Error ? error.message : '候选修复未完成' });
            await events;
            throw error;
          });
          const key = `reviewed:v2:${candidateVersion}`;
          await repo.saveArtifact(id, generation, key, { ...candidate, result: revised, candidate_version: candidateVersion });
          return { ...common, reviewed: key };
        }
        const done = await completed(state);
        if (report.recovery.action === 'research') {
          if (state.trace.supplement_count || state.steps.length >= this.supervisor.maxPlanSteps())
            throw new AgentExecutionError('AGENT_REVIEW_FAILED', '补充研究额度已使用，请补充资料后重新生成');
          const step = { id: `verification_research_${state.planVersion}`, capability: 'search' as const,
            description: report.recovery.instruction, depends_on: Object.keys(done) };
          const trace = { ...state.trace, supplement_count: state.trace.supplement_count + 1 };
          return { ...common, trace, steps: [...state.steps, step],
            plan: state.plan ?? { goal: request.query, outline: [], constraints: [], steps: [step] } };
        }
        const invalidated = dependencyClosure(state.steps, report.recovery.step_ids);
        if (!invalidated.length) throw new AgentExecutionError('AGENT_REVIEW_FAILED', '无法定位需要重新执行的步骤');
        const replanning = { invalidated_steps: invalidated, reused_steps: Object.keys(done).filter((key) => !invalidated.includes(key)),
          plan_version: state.planVersion + 1 };
        emit('replanning', replanning);
        await repo.saveDelivery(id, generation, { replanning });
        return { ...common, planVersion: state.planVersion + 1,
          invalidated: Object.fromEntries(invalidated.map((key) => [key, true])) };
      }))
      .addConditionalEdges('review_candidate', () => 'verify_evidence')
      .addConditionalEdges('verify_evidence', async (state: State) => {
        const report = await repo.artifact<VerificationReport>(id, state.verification);
        return report.passed ? 'deliver' : 'recover_candidate';
      })
      .addConditionalEdges('recover_candidate', async (state: State) => {
        if (Object.values(state.questions).some(Boolean)) return 'clarify';
        const report = await repo.artifact<VerificationReport>(id, state.verification);
        return ['repair', 'none'].includes(report.recovery.action) ? research ? 'review_candidate' : 'verify_evidence' : state.steps.length ? 'decide_next' : 'compose';
      });
    } else builder.addEdge('review_candidate', 'deliver');
    const saver = new MySqlCheckpointSaver(repo.db, async (manager) => {
      await repo.fence(manager, id, generation);
    });
    return {
      graph: builder.compile({ checkpointer: saver }),
      flush: () => events,
    };
  }
}
