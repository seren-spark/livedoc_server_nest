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
import { parseModelJson, validatePlan } from "../document-agent.validation.js";
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

const GraphState = Annotation.Root({
  base: Annotation<string>(),
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
  outputs: Annotation<Record<string, string>>({
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
});
type State = typeof GraphState.State;

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

  async build(run: GraphRun, context: AccessContext, signal: AbortSignal) {
    const repo = this.repository,
      generation = run.execution_generation,
      id = run.run_id;
    const request = await repo.artifact<DocumentAgentDto>(id, "input");
    const personal = await this.settings.runtime(context);
    const budget = run.budget;
    let events: Promise<void> = Promise.resolve();
    const emit = (event: string, data: Record<string, any>) => {
      if (event === "done") return;
      events = events.then(() => repo.event(id, generation, event, data));
      // The node barrier below propagates this error before any following checkpoint.
      void events.catch(() => undefined);
    };
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
    const output = async (key: string) => {
      const value = await repo.artifact<WorkerOutput>(id, key);
      await this.document.validateGraphSources(
        value.citations,
        value.wiki_reads ?? [],
        context,
      );
      return value;
    };
    const completed = async (
      state: State,
    ): Promise<Record<string, WorkerOutput>> =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(state.outputs).map(async ([key, ref]) => [
            key,
            await output(ref),
          ]),
        ),
      );
    const base = (state: State) => repo.artifact<any>(id, state.base);
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
    const worker = async (
      state: State,
      step?: ExecutionPlan["steps"][number],
      executionLimit?: number,
      stepTurnLimit?: number,
    ) => {
      const b = await base(state),
        dependencies = await completed(state);
      const env = environment(state, !step);
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
          ...(state.plan ? { execution_plan: state.plan } : {}),
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
                      "判断任务为 react 单步或 plan_execute 多步骤，并判断是否需要检索用户选定的知识库。局部润色、问候及无关问题不需要检索；相关事实查询需要。只返回 JSON {strategy,reason,needs_knowledge:boolean}。",
                  },
                  {
                    role: "user",
                    content: JSON.stringify({
                      query: request.query,
                      reference_count: request.references.length,
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
              approval || route.strategy === "plan_execute" || needsKnowledge,
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
          if (
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
                    `为任务生成最多${this.supervisor.maxPlanSteps()}步的无环计划。仅返回 JSON {goal,outline:[],constraints:[],steps:[{id,description,depends_on:[],capability:"read"|"search"|"compose"}]}。不扩大知识库或联网范围。` +
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
          return { approved: false, planFeedback: command.text ?? "" };
        if (command.action !== "approve_plan")
          throw new BadRequestException("需要确认计划");
        const plan = command.plan ? validatePlan(command.plan) : state.plan!;
        this.supervisor.assertPlanFits(plan);
        return { plan, steps: plan.steps, approved: true };
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
            (s) => !state.outputs[s.id],
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
            4,
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
          const key = `step:${step.id}`;
          await repo.saveArtifact(id, generation, key, result);
          emit("step", {
            id: step.id,
            description: step.description,
            status: "done",
          });
          return { outputs: { [step.id]: key } };
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
        return { questions: { [key]: null }, answers: { [key]: command.text } };
      })
      .addNode(
        "compose",
        wrap("compose", async (state: State) => {
          const result = await worker(state);
          if (result.result.kind === "clarification")
            return { questions: { primary: result.result } };
          const key = `primary:${run.execution_generation}`;
          await repo.saveArtifact(id, generation, key, result);
          return { primary: key };
        }),
      )
      .addNode(
        "review_candidate",
        wrap("review_candidate", async (state: State) => {
          const result = await output(state.primary),
            b = await base(state);
          const review = await this.document.reviewCandidate(
            result.result,
            environment(state, true),
            b.context,
            state.plan ?? undefined,
            new Map(result.citations.map((c) => [c.id, c])),
            new Map(result.evidence),
            run,
          );
          const key = `reviewed:${run.execution_generation}`;
          await repo.saveArtifact(id, generation, key, {
            ...result,
            result: review.candidate,
            reflection: run.payload.reflection,
            candidate_version: review.revised ? 1 : 0,
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
            : "decide_next"
          : s.needsPlan
            ? "make_plan"
            : "compose",
      )
      .addConditionalEdges("make_plan", (s) =>
        s.needsApproval && !s.approved ? "review_plan" : "decide_next",
      )
      .addConditionalEdges("review_plan", (s) =>
        s.approved ? "decide_next" : "make_plan",
      )
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
      .addConditionalEdges("clarify", (s) =>
        Object.values(s.questions).some(Boolean)
          ? "clarify"
          : s.plan
            ? "decide_next"
            : "compose",
      )
      .addConditionalEdges("compose", (s) =>
        Object.values(s.questions).some(Boolean)
          ? "clarify"
          : "review_candidate",
      )
      .addEdge("review_candidate", "deliver")
      .addEdge("deliver", END);
    const saver = new MySqlCheckpointSaver(repo.db, async (manager) => {
      await repo.fence(manager, id, generation);
    });
    return {
      graph: builder.compile({ checkpointer: saver }),
      flush: () => events,
    };
  }
}
