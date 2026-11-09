import {
  Injectable,
  OnModuleDestroy,
  ConflictException,
  ServiceUnavailableException,
  HttpException,
} from "@nestjs/common";
import { Command, RunControl, isGraphDrained } from "@langchain/langgraph";
import { AppConfig } from "../../config/app-config.js";
import { AuthService } from "../../auth/auth.service.js";
import type { AccessContext } from "../../common/types.js";
import { DocumentAgentService } from "../document-agent.service.js";
import { AgentSupervisorService } from "../agent-supervisor.service.js";
import { LlmService } from "../llm.service.js";
import { WikiService } from "../../wiki/wiki.service.js";
import { AgentAuditService } from "../agent-audit.service.js";
import { agentFailure, AgentExecutionError } from "../agent-execution.js";
import { validatePlan } from "../document-agent.validation.js";
import type { DocumentAgentDto } from "../document-agent.dto.js";
import type { WorkerOutput } from "../agent-runtime.types.js";
import {
  AgentRunRepository,
  GRAPH_TERMINAL,
  type GraphRun,
  type RunCommand,
} from "./agent-run.repository.js";
import { AgentGraphWorkflow } from "./agent-graph.workflow.js";
import { MySqlCheckpointSaver } from "./mysql-checkpoint-saver.js";

@Injectable()
export class AgentGraphService implements OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private closed = false;
  private polls = 0;
  private readonly active = new Map<
    string,
    { control: RunControl; abort: AbortController; promise: Promise<void> }
  >();
  constructor(
    readonly repository: AgentRunRepository,
    private readonly workflow: AgentGraphWorkflow,
    private readonly document: DocumentAgentService,
    private readonly supervisor: AgentSupervisorService,
    private readonly auth: AuthService,
    private readonly config: AppConfig,
    private readonly llm: LlmService,
    private readonly wiki: WikiService,
    private readonly audit: AgentAuditService,
  ) {}

  start() {
    if (!this.repository.db.metadataEnabled || this.timer) return;
    this.timer = setInterval(
      () =>
        void this.tick().catch((error) =>
          console.error("Agent task poll failed", error),
        ),
      1000,
    );
    this.timer.unref();
  }

  async tick() {
    if (this.ticking || this.closed || !this.repository.db.metadataEnabled)
      return;
    this.ticking = true;
    try {
      if (++this.polls % 60 === 0) await this.repository.cleanup();
      while (this.active.size < this.config.agentMaxConcurrentRuns) {
        const run = await this.repository.claim();
        if (!run) break;
        const control = new RunControl(),
          abort = new AbortController();
        const promise = this.execute(run, control, abort)
          .catch((error) =>
            console.error("Agent task finalization failed", error),
          )
          .finally(() => this.active.delete(run.run_id));
        this.active.set(run.run_id, { control, abort, promise });
      }
    } finally {
      this.ticking = false;
    }
  }

  async create(input: DocumentAgentDto, context: AccessContext) {
    this.repository.assertEnabled();
    if (!this.llm.isConfigured)
      throw new ServiceUnavailableException("请配置模型后使用文档 Agent");
    // Check deduplication before revalidating a previously accepted request's now-changed editor version.
    const previous = await this.repository.findRequest(
      input.request_id,
      context,
    );
    if (previous) return this.publicRun(previous);
    await this.document.validateIdentity(input, context);
    const run = await this.repository.create(input, context);
    return this.publicRun(run);
  }

  publicRun(run: GraphRun, includeWaiting = false) {
    return {
      run_id: run.run_id,
      conversation_id: run.conversation_id,
      mode: run.mode,
      status: run.status,
      stage: run.stage,
      revision: run.revision,
      last_seq: run.last_seq,
      pause_requested: run.pause_requested,
      waiting:
        includeWaiting &&
        (run.status === "waiting_input" ||
          (run.status === "interrupted" &&
            run.control.waiting?.value?.type === "retry"))
          ? (run.control.waiting ?? null)
          : null,
      payload: {
        identity: run.payload.identity,
        query: run.payload.query,
        output_target: run.payload.output_target,
        error: run.payload.error,
        feedback: run.payload.feedback,
      },
      usage: run.budget,
      active_ms: run.active_ms,
      can_resume:
        ["paused", "waiting_input", "interrupted"].includes(run.status) &&
        run.resumable_until.getTime() > Date.now(),
    };
  }

  async get(id: string, context: AccessContext) {
    const run = await this.repository.get(id, context);
    if (run.status === "waiting_input") {
      try {
        await this.authorizeProgress(id, context);
      } catch (error) {
        if (
          !(error instanceof HttpException) ||
          ![403, 404, 409].includes(error.getStatus())
        )
          throw error;
        const result = this.publicRun(run);
        return {
          ...result,
          can_resume: false,
          payload: {
            ...result.payload,
            error: "资料访问权限或版本已变化，请重新创建任务",
          },
        };
      }
    }
    return this.publicRun(run, true);
  }
  async authorizeProgress(id: string, context: AccessContext) {
    const current = await this.auth.identityByUserId(context.user_id);
    if (!current || current.space_id !== context.space_id)
      throw new ConflictException("访问身份已失效");
    const input = await this.repository.artifact<DocumentAgentDto>(id, "input");
    await this.document.validateIdentity(input, current, undefined, true);
    const tuple = await new MySqlCheckpointSaver(this.repository.db).getTuple({
      configurable: { thread_id: id },
    });
    for (const ref of Object.values(
      (tuple?.checkpoint.channel_values.outputs ?? {}) as Record<
        string,
        string
      >,
    )) {
      const result = await this.repository.artifact<WorkerOutput>(id, ref);
      await this.document.validateGraphSources(
        result.citations,
        result.wiki_reads ?? [],
        current,
      );
    }
  }
  async list(context: AccessContext, conversation?: string, key?: string) {
    if (!this.repository.db.metadataEnabled) return [];
    return (await this.repository.list(context, conversation, key)).map((r) =>
      this.publicRun(r),
    );
  }

  async command(
    id: string,
    context: AccessContext,
    command: RunCommand,
    kind: "pause" | "resume" | "stop",
  ) {
    const owned = await this.repository.get(id, context);
    // Idempotent retries must work even if the task has since finished or inputs expired.
    if (!owned.control.requests?.[command.request_id] && kind === "resume") {
      if (command.plan)
        this.supervisor.assertPlanFits(validatePlan(command.plan));
      if (command.action === "revise_plan" && !command.text?.trim())
        throw new ConflictException("请输入计划调整要求");
      if (command.action === "answer" && !command.text?.trim())
        throw new ConflictException("请输入补充信息");
      const input = await this.repository.artifact<DocumentAgentDto>(
        id,
        "input",
      );
      await this.document.validateIdentity(input, context, undefined, true);
      if (!this.compatible(owned))
        throw new ConflictException("任务运行配置已变化，请重新创建任务");
      const checkpoint = await new MySqlCheckpointSaver(
        this.repository.db,
      ).getTuple({ configurable: { thread_id: id } });
      const state = checkpoint?.checkpoint.channel_values;
      for (const ref of Object.values(
        (state?.outputs ?? {}) as Record<string, string>,
      )) {
        const result = await this.repository.artifact<WorkerOutput>(id, ref);
        await this.document.validateGraphSources(
          result.citations,
          result.wiki_reads ?? [],
          context,
        );
      }
    }
    const run = await this.repository.command(id, context, command, kind);
    const active = this.active.get(id);
    if (kind === "pause" && run.pause_requested)
      active?.control.requestDrain("user-pause");
    if (kind === "stop" && run.status === "stopped")
      active?.abort.abort(new Error("任务已停止"));
    return this.publicRun(run);
  }

  private async execute(
    run: GraphRun,
    control: RunControl,
    abort: AbortController,
  ) {
    const repo = this.repository,
      id = run.run_id,
      generation = run.execution_generation,
      started = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let beating = false;
    try {
      const remaining = run.payload.limits.total_seconds * 1000 - run.active_ms;
      if (remaining <= 0)
        throw new AgentExecutionError("AGENT_TIMEOUT", "累计执行时间已达上限");
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(remaining),
      ]);
      const context = await this.auth.identityByUserId(run.user_id);
      if (!context || context.space_id !== run.space_id)
        throw new AgentExecutionError("ACCESS_DENIED", "用户访问身份已失效");
      if (!this.compatible(run))
        throw new AgentExecutionError(
          "WORKFLOW_CHANGED",
          "任务执行版本或配置已变化",
        );
      await repo.settleAbandoned(id, generation);
      run = await repo.internal(id);
      heartbeat = setInterval(() => {
        if (beating) return;
        beating = true;
        void repo
          .heartbeat(id, generation)
          .then((current) => {
            if (current.pause_requested) control.requestDrain("user-pause");
          })
          .catch((error) => abort.abort(error))
          .finally(() => {
            beating = false;
          });
      }, 20000);
      if (run.pause_requested) control.requestDrain("user-pause");
      await repo.event(id, generation, "run_started", {
        mode: run.mode,
        output_target: run.payload.output_target,
        graph: true,
      });
      const { graph, flush } = await this.workflow.build(run, context, signal);
      const config = {
        configurable: { thread_id: id },
        control,
        signal,
        durability: "sync" as const,
        recursionLimit: 100,
      };
      const snapshot = await graph.getState(config);
      const hasCheckpoint = Boolean(
        snapshot.config.configurable?.checkpoint_id,
      );
      const unresolved = snapshot.tasks.flatMap(
        (task) => task.interrupts ?? [],
      );
      const acceptsInput =
        run.control.waiting &&
        unresolved.some((item) => item.id === run.control.waiting.id);
      const input =
        run.control.resume && acceptsInput
          ? new Command({
              resume: { [run.control.waiting.id]: run.control.resume },
            })
          : hasCheckpoint
            ? null
            : {};
      const result = await graph.invoke(input as any, config);
      await flush();
      const final = await graph.getState(config);
      const interruptions = final.tasks.flatMap(
        (task) => task.interrupts ?? [],
      );
      let status: string;
      if (interruptions.length) {
        const waiting = interruptions[0]!;
        status =
          (waiting.value as any)?.type === "retry"
            ? "interrupted"
            : "waiting_input";
        await repo.finish(id, generation, status, Date.now() - started, {
          waiting: { id: waiting.id, value: waiting.value },
        });
        await repo.event(id, undefined, "waiting_input", {
          waiting: { id: waiting.id, value: waiting.value },
        });
      } else {
        status = result.finalStatus || "completed";
        await repo.finish(id, generation, status, Date.now() - started, {
          waiting: null,
        });
      }
      await repo.event(id, undefined, "done", { status });
      if (status === "completed") {
        const saved = await repo.internal(id);
        if (
          saved.payload.delivery?.result.kind === "answer" &&
          saved.payload.wiki_origin
        )
          this.wiki.enqueueCapture(
            saved,
            saved.payload.delivery.result.answer,
            context,
            saved.payload.wiki_reads ?? [],
            (state) => this.audit.recordWikiCapture(id, context, state),
          );
      }
    } catch (error) {
      const current = await repo.internal(id);
      if (
        current.status !== "running" ||
        current.execution_generation !== generation
      )
        return;
      const failure = agentFailure(error);
      const status = this.closed
        ? "interrupted"
        : isGraphDrained(error)
          ? control.drainReason === "user-pause"
            ? "paused"
            : "interrupted"
          : failure.retryable
            ? "interrupted"
            : "failed";
      await repo.finish(
        id,
        generation,
        status,
        Date.now() - started,
        {},
        isGraphDrained(error)
          ? undefined
          : {
              code: failure.code,
              message: error instanceof Error ? error.message : "任务执行失败",
            },
      );
      await repo.event(id, undefined, "done", {
        status: (await repo.internal(id)).status,
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private compatible(run: GraphRun) {
    return (
      run.graph_version === "v1" &&
      run.payload.config_fingerprint === this.config.configFingerprint &&
      run.payload.limits.execution_turns === this.config.agentMaxToolCalls &&
      run.payload.limits.max_output_tokens === this.config.agentMaxOutputTokens
    );
  }

  async onModuleDestroy() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const task of this.active.values())
      task.control.requestDrain("shutdown");
    const work = Promise.allSettled(
      [...this.active.values()].map((task) => task.promise),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    for (const task of this.active.values())
      task.abort.abort(new Error("服务正在停止"));
    await work;
  }
}
