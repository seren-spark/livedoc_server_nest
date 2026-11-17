/**
 * @file 图任务存储。持久化运行记录、事件、产物、租约和预算结算，支撑任务恢复。
 */
import {
  Injectable,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
} from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import type { EntityManager } from "typeorm";
import { DatabaseService } from "../../database/database.service.js";
import { AppConfig } from "../../config/app-config.js";
import type { AccessContext } from "../../common/types.js";
import type { DocumentAgentDto } from "../document-agent.dto.js";
import type { AgentRunRecord } from "../agent-audit.service.js";
import { emptyUsage, type AgentUsage } from "../agent-runtime.types.js";
import { AgentExecutionError } from "../agent-execution.js";
import { graphFingerprint, V2_POLICY, RESEARCH_POLICY } from './graph-policy.js';
import type { WritingSkillSnapshot } from '../writing-skills.types.js';

export const GRAPH_TERMINAL = [
  "awaiting_review",
  "completed",
  "failed",
  "stopped",
];
export interface GraphRun extends AgentRunRecord {
  graph_version: string;
  revision: number;
  stage: string;
  execution_generation: number;
  pause_requested: boolean;
  last_seq: number;
  active_ms: number;
  budget: AgentUsage;
  control: {
    requests?: Record<string, unknown>;
    resume?: unknown;
    waiting?: any;
  };
  resumable_until: Date;
  lease_expires_at: Date | null;
}
export interface RunCommand {
  request_id: string;
  expected_revision: number;
  action?: "continue" | "approve_plan" | "revise_plan" | "answer";
  interrupt_id?: string;
  plan?: unknown;
  text?: string;
}
/**
 * 解析 JSON 数据，兼容已解码的对象。
 *
 * @param value 待校验或转换的值。
 * @returns 本次操作整理后的结果。
 */
const json = (value: any) =>
  typeof value === "string" ? JSON.parse(value) : value;
/**
 * 将数据库任务行转换为图任务业务对象。
 *
 * @param r 当前需要处理的记录或响应。
 * @returns 持久化图任务记录。
 */
const row = (r: any): GraphRun => ({
  ...r,
  payload: json(r.payload),
  budget: json(r.budget) ?? emptyUsage(),
  control: json(r.control) ?? {},
  pause_requested: Boolean(r.pause_requested),
  active_ms: Number(r.active_ms),
  resumable_until: new Date(r.resumable_until),
  lease_expires_at: r.lease_expires_at ? new Date(r.lease_expires_at) : null,
});

@Injectable()
export class AgentRunRepository {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param db 共享数据库服务。
   * @param config 应用运行配置。
   */
  constructor(
    readonly db: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  /**
   * 确认当前配置已启用所需的持久化能力。
   */
  assertEnabled() {
    if (!this.config.agentGraphEnabled)
      throw new NotFoundException("可恢复任务未启用");
    if (!this.db.metadataEnabled)
      throw new ServiceUnavailableException("可恢复任务必须配置 MySQL");
  }

  /**
   * 按标识读取图任务。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 持久化图任务记录。
   */
  async get(id: string, context: AccessContext): Promise<GraphRun> {
    const rows = await this.db.query(
      "SELECT * FROM agent_runs WHERE run_id=? AND user_id=? AND space_id=? AND graph_version IS NOT NULL",
      [id, context.user_id, context.space_id],
    );
    if (!rows[0]) throw new NotFoundException("任务不存在");
    return row(rows[0]);
  }

  /**
   * 按内部任务标识读取完整运行记录。
   *
   * @param id 目标记录的唯一标识。
   * @returns 持久化图任务记录。
   */
  async internal(id: string): Promise<GraphRun> {
    const rows = await this.db.query(
      "SELECT * FROM agent_runs WHERE run_id=? AND graph_version IS NOT NULL",
      [id],
    );
    if (!rows[0]) throw new NotFoundException("任务不存在");
    return row(rows[0]);
  }

  /**
   * 按请求幂等标识查找已经创建的任务。
   *
   * @param requestId request 对应的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 持久化图任务记录；未找到或不可用时可能为空。
   */
  async findRequest(
    requestId: string,
    context: AccessContext,
  ): Promise<GraphRun | null> {
    const [found] = await this.db.query<any>(
      "SELECT * FROM agent_runs WHERE request_id=? AND user_id=? AND space_id=? AND graph_version IS NOT NULL",
      [requestId, context.user_id, context.space_id],
    );
    return found ? row(found) : null;
  }

  /**
   * 按查询条件读取图任务列表。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param conversation 用于筛选任务的会话标识（可选）。
   * @param documentKey documentKey 参数（string）（可选）。
   * @returns 持久化图任务记录列表。
   */
  async list(
    context: AccessContext,
    conversation?: string,
    documentKey?: string,
  ) {
    const rows = await this.db.query(
      `SELECT * FROM agent_runs WHERE user_id=? AND space_id=? AND graph_version IS NOT NULL
      ${conversation ? "AND conversation_id=?" : ""} ${documentKey ? "AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.document_key'))=?" : ""}
      ORDER BY created_at DESC LIMIT 20`,
      [
        context.user_id,
        context.space_id,
        ...(conversation ? [conversation] : []),
        ...(documentKey ? [documentKey] : []),
      ],
    );
    return rows.map(row);
  }

  /**
   * 根据输入创建图任务并返回结果。
   *
   * @param request 包含写作需求、编辑器快照和参考资料的 Agent 请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param skill 当前写作技能定义或快照（可选）。
   * @returns 持久化图任务记录。
   */
  async create(request: DocumentAgentDto, context: AccessContext, skill?: WritingSkillSnapshot) {
    this.assertEnabled();
    return this.db.transaction(async (manager) => {
      const [existing] = await manager.query(
        "SELECT * FROM agent_runs WHERE request_id=? AND user_id=? AND space_id=?",
        [request.request_id, context.user_id, context.space_id],
      );
      if (existing) {
        if (!existing.graph_version)
          throw new ConflictException("该请求属于旧版任务");
        return row(existing);
      }
      const [count] = await manager.query(
        "SELECT COUNT(*) AS total FROM agent_runs WHERE user_id=? AND space_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 MINUTE)",
        [context.user_id, context.space_id],
      );
      if (Number(count.total) >= 10)
        throw new HttpException("达到每分钟任务限额", 429);
      const id = randomUUID(),
        identity = request.editor_snapshot.identity;
      const documentKey =
        identity.kind +
        ":" +
        (identity.kind === "knowledge"
          ? identity.doc_id
          : identity.kind === "article"
            ? identity.article_id
            : identity.kind === "import"
              ? identity.import_id
              : identity.local_id);
      const payload = {
        identity,
        document_key: documentKey,
        snapshot_hash: createHash("sha256")
          .update(JSON.stringify(request.editor_snapshot.json))
          .digest("hex"),
        query: request.query,
        output_target: request.output_target,
        feedback: {},
        traces: [],
        workflow_version: this.config.agentGraphVersion,
        ...(this.config.agentGraphVersion === 'v2' ? { policy: skill?.skill.workflow === 'research_writing' ? RESEARCH_POLICY : V2_POLICY } : {}),
        config_fingerprint: graphFingerprint(this.config.configFingerprint, this.config.agentGraphVersion,
          this.config.agentGraphVersion === 'v2' ? skill?.skill.workflow === 'research_writing' ? RESEARCH_POLICY : V2_POLICY : undefined),
        limits: {
          total_tokens: this.config.agentMaxTotalTokens,
          model_requests: this.config.agentMaxModelRequests,
          execution_turns: this.config.agentMaxToolCalls,
          max_output_tokens: this.config.agentMaxOutputTokens,
          total_seconds: this.config.agentTimeoutSeconds,
        },
      };
      const until = new Date(
        Date.now() + this.config.agentGraphRetentionDays * 86400000,
      );
      await manager.query(
        `INSERT INTO agent_runs(run_id,request_id,user_id,space_id,conversation_id,mode,status,payload,graph_version,budget,control,resumable_until)
        VALUES(?,?,?,?,?,?,'queued',?,?,?,'{}',?) ON DUPLICATE KEY UPDATE run_id=run_id`,
        [
          id,
          request.request_id,
          context.user_id,
          context.space_id,
          request.conversation_id,
          request.mode,
          JSON.stringify(payload),
          this.config.agentGraphVersion,
          JSON.stringify(emptyUsage()),
          until,
        ],
      );
      const [accepted] = await manager.query(
        "SELECT * FROM agent_runs WHERE request_id=? AND user_id=? AND space_id=? FOR UPDATE",
        [request.request_id, context.user_id, context.space_id],
      );
      if (accepted.run_id !== id) {
        if (!accepted.graph_version)
          throw new ConflictException("该请求属于旧版任务");
        return row(accepted);
      }
      await manager.query(
        "INSERT INTO agent_run_artifacts(run_id,artifact_key,payload) VALUES(?,?,?)",
        [id, "input", JSON.stringify(request)],
      );
      if (skill) await manager.query(
        'INSERT INTO agent_run_artifacts(run_id,artifact_key,payload) VALUES(?,?,?)',
        [id, 'selected_skill', JSON.stringify(skill)],
      );
      const [created] = await manager.query(
        "SELECT * FROM agent_runs WHERE run_id=?",
        [id],
      );
      return row(created);
    });
  }

  /**
   * 锁定任务并检查执行代次，阻止旧 Worker 写入新一轮任务。
   *
   * @param manager 当前数据库事务执行器。
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @returns 持久化图任务记录。
   */
  async fence(manager: EntityManager, id: string, generation: number) {
    const [record] = await manager.query(
      "SELECT * FROM agent_runs WHERE run_id=? FOR UPDATE",
      [id],
    );
    if (
      !record ||
      record.status !== "running" ||
      Number(record.execution_generation) !== generation ||
      !record.lease_expires_at ||
      new Date(record.lease_expires_at).getTime() <= Date.now()
    )
      throw new AgentExecutionError("AGENT_LEASE_LOST", "任务执行权已失效");
    return row(record);
  }

  /**
   * 原子领取可执行任务，并更新 Worker 租约。
   *
   * @returns 持久化图任务记录；未找到或不可用时可能为空。
   */
  async claim(): Promise<GraphRun | null> {
    return this.db.transaction(async (manager) => {
      await manager.query(
        "UPDATE agent_runs SET status='interrupted',revision=revision+1,lease_expires_at=NULL WHERE graph_version IS NOT NULL AND status='running' AND lease_expires_at<=UTC_TIMESTAMP(6)",
      );
      const [count] = await manager.query(
        "SELECT COUNT(*) AS total FROM agent_runs WHERE graph_version IS NOT NULL AND status='running'",
      );
      if (Number(count.total) >= this.config.agentMaxConcurrentRuns)
        return null;
      const [next] =
        await manager.query(`SELECT r.* FROM agent_runs r WHERE r.graph_version IN ('v1','v2') AND r.status='queued'
        AND NOT EXISTS(SELECT 1 FROM agent_runs a WHERE a.user_id=r.user_id AND a.space_id=r.space_id AND a.status='running')
        ORDER BY r.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!next) return null;
      await manager.query(
        "UPDATE agent_runs SET status='running',revision=revision+1,execution_generation=execution_generation+1,lease_expires_at=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 60 SECOND) WHERE run_id=?",
        [next.run_id],
      );
      const [claimed] = await manager.query(
        "SELECT * FROM agent_runs WHERE run_id=?",
        [next.run_id],
      );
      return row(claimed);
    });
  }

  /**
   * 续期当前 Worker 的任务租约。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @returns 持久化图任务记录。
   */
  async heartbeat(id: string, generation: number) {
    return this.db.transaction(async (manager) => {
      const run = await this.fence(manager, id, generation);
      await manager.query(
        "UPDATE agent_runs SET lease_expires_at=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 60 SECOND) WHERE run_id=?",
        [id],
      );
      return run;
    });
  }

  /**
   * 读取必需的持久化任务产物，缺失时中止当前操作。
   *
   * @param id 目标记录的唯一标识。
   * @param key 查询或存储使用的键。
   * @returns T 类型的处理结果。
   */
  async artifact<T>(id: string, key: string): Promise<T> {
    const [record] = await this.db.query<any>(
      "SELECT payload FROM agent_run_artifacts WHERE run_id=? AND artifact_key=?",
      [id, key],
    );
    if (!record) throw new ConflictException("恢复资料已失效，请重新创建任务");
    return json(record.payload);
  }

  /**
   * 读取可选任务产物，允许产物尚未生成。
   *
   * @param id 目标记录的唯一标识。
   * @param key 查询或存储使用的键。
   * @returns T 类型的处理结果；未找到或不可用时可能为空。
   */
  async optionalArtifact<T>(id: string, key: string): Promise<T | null> {
    const [record] = await this.db.query<any>('SELECT payload FROM agent_run_artifacts WHERE run_id=? AND artifact_key=?', [id, key]);
    return record ? json(record.payload) : null;
  }

  /**
   * 保存任务中间产物，供后续节点和恢复路径复用。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param key 查询或存储使用的键。
   * @param value 待校验或转换的值。
   */
  async saveArtifact(
    id: string,
    generation: number,
    key: string,
    value: unknown,
  ) {
    await this.db.transaction(async (manager) => {
      await this.fence(manager, id, generation);
      await manager.query(
        "INSERT INTO agent_run_artifacts(run_id,artifact_key,payload) VALUES(?,?,?) ON DUPLICATE KEY UPDATE artifact_key=artifact_key",
        [id, key, JSON.stringify(value)],
      );
    });
  }

  /**
   * 更新运行所处阶段并记录相关状态。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param stage 当前任务执行阶段。
   */
  async stage(id: string, generation: number, stage: string) {
    await this.db.transaction(async (manager) => {
      await this.fence(manager, id, generation);
      await manager.query("UPDATE agent_runs SET stage=? WHERE run_id=?", [
        stage,
        id,
      ]);
    });
  }

  /**
   * 把当前执行的阶段追踪写入任务记录。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param traces 当前范围内的检索或执行追踪。
   */
  async recordTraces(id: string, generation: number, traces: unknown) {
    await this.db.transaction(async (manager) => {
      await this.fence(manager, id, generation);
      await manager.query(
        "UPDATE agent_runs SET payload=JSON_SET(payload,'$.traces',CAST(? AS JSON)) WHERE run_id=?",
        [JSON.stringify(traces), id],
      );
    });
  }

  /**
   * 持久化已经校验的交付结果及其引用证据。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param payload 需要传递或持久化的业务数据。
   */
  async saveDelivery(
    id: string,
    generation: number,
    payload: Record<string, any>,
  ) {
    await this.db.transaction(async (manager) => {
      await this.fence(manager, id, generation);
      // Preserve concurrent feedback/capture fields; delivery can only be committed while running.
      const { feedback: _feedback, ...fields } = payload;
      await manager.query(
        "UPDATE agent_runs SET payload=JSON_MERGE_PATCH(payload,CAST(? AS JSON)) WHERE run_id=?",
        [JSON.stringify(fields), id],
      );
    });
  }

  /**
   * 保存一条可按游标读取的任务事件。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param event 需要处理的事件。
   * @param data 当前事件或操作携带的数据。
   */
  async event(
    id: string,
    generation: number | undefined,
    event: string,
    data: Record<string, any>,
  ) {
    // Reconnect progress contains no source body or candidate; clients use the access-checked restore endpoint.
    if (["delta", "result", "done"].includes(event))
      data =
        event === "result"
          ? { candidate_version: data.candidate_version }
          : event === "done"
            ? { status: data.status }
            : {};
    if (event === "delta") return;
    if (event === "tool_result") {
      const { citations: _citations, ...progress } = data;
      data = progress;
    }
    await this.db.transaction(async (manager) => {
      const run =
        generation === undefined
          ? row(
              (
                await manager.query(
                  "SELECT * FROM agent_runs WHERE run_id=? FOR UPDATE",
                  [id],
                )
              )[0],
            )
          : await this.fence(manager, id, generation);
      const seq = run.last_seq + 1;
      await manager.query(
        "INSERT INTO agent_run_events(run_id,seq,event,payload) VALUES(?,?,?,?)",
        [id, seq, event, JSON.stringify({ ...data, run_id: id, seq })],
      );
      await manager.query("UPDATE agent_runs SET last_seq=? WHERE run_id=?", [
        seq,
        id,
      ]);
    });
  }

  /**
   * 读取指定游标之后的任务事件。
   *
   * @param id 目标记录的唯一标识。
   * @param after 本次变更后的内容或状态。
   * @returns 整理后的结果列表。
   */
  async events(id: string, after: number) {
    const rows = await this.db.query<any>(
      "SELECT seq,event,payload FROM agent_run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200",
      [id, after],
    );
    return rows.map((r) => ({
      event: r.event as string,
      data: json(r.payload),
    }));
  }

  /**
   * 在执行代次有效时保存任务终态，同时保留已经生成的有效交付。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param status 本次需要记录或切换到的状态。
   * @param elapsed 当前步骤已消耗的时间。
   * @param control 当前任务的控制输入。
   * @param error 本次操作捕获的异常（可选）。
   */
  async finish(
    id: string,
    generation: number,
    status: string,
    elapsed: number,
    control: GraphRun["control"],
    error?: { code: string; message: string },
  ) {
    await this.db.transaction(async (manager) => {
      const run = await this.fence(manager, id, generation);
      if (
        run.payload.delivery &&
        GRAPH_TERMINAL.includes(status) &&
        status !== "completed" &&
        status !== "awaiting_review"
      )
        status = ["document", "edits"].includes(
          run.payload.delivery.result.kind,
        )
          ? "awaiting_review"
          : "completed";
      const preserveInput =
        ["paused", "interrupted"].includes(status) &&
        Boolean(run.control.resume);
      const nextControl = {
        ...run.control,
        ...control,
        waiting:
          control.waiting !== undefined
            ? control.waiting
            : preserveInput
              ? run.control.waiting
              : null,
        resume: preserveInput ? run.control.resume : null,
      };
      await manager.query(
        `UPDATE agent_runs SET status=?,revision=revision+1,lease_expires_at=NULL,pause_requested=FALSE,
        active_ms=active_ms+?,control=?,payload=JSON_MERGE_PATCH(payload,CAST(? AS JSON)),completed_at=? WHERE run_id=?`,
        [
          status,
          elapsed,
          JSON.stringify(nextControl),
          JSON.stringify(
            error
              ? { error: error.message, failure: { code: error.code } }
              : { error: null, failure: null },
          ),
          GRAPH_TERMINAL.includes(status) ? new Date() : null,
          id,
        ],
      );
    });
  }

  /**
   * 处理暂停、继续或停止指令，并更新任务控制状态。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param command 本次图任务控制命令。
   * @param kind 当前结果或来源的分类。
   * @returns 持久化图任务记录。
   */
  async command(
    id: string,
    context: AccessContext,
    command: RunCommand,
    kind: "pause" | "resume" | "stop",
  ) {
    return this.db.transaction(async (manager) => {
      const [record] = await manager.query(
        "SELECT * FROM agent_runs WHERE run_id=? AND user_id=? AND space_id=? AND graph_version IS NOT NULL FOR UPDATE",
        [id, context.user_id, context.space_id],
      );
      if (!record) throw new NotFoundException("任务不存在");
      const run = row(record),
        previous = run.control.requests?.[command.request_id];
      const fingerprint = JSON.stringify({ kind, ...command });
      if (previous) {
        if (previous !== fingerprint)
          throw new ConflictException("相同操作标识不能用于不同操作");
        return run;
      }
      if (run.revision !== command.expected_revision)
        throw new ConflictException("任务已更新，请刷新后操作");
      let status = run.status;
      if (kind === "resume") {
        if (!["waiting_input", "paused", "interrupted"].includes(status))
          throw new ConflictException("任务当前不能继续");
        if (run.resumable_until.getTime() <= Date.now())
          throw new ConflictException("恢复窗口已过期，请重新创建任务");
        if (status === "waiting_input") {
          if (command.interrupt_id !== run.control.waiting?.id)
            throw new ConflictException("等待项已更新");
          const type = run.control.waiting.value?.type;
          if (
            type === "plan"
              ? !["approve_plan", "revise_plan"].includes(command.action ?? "")
              : command.action !== "answer"
          )
            throw new ConflictException("操作与等待项不匹配");
        } else if (command.action !== "continue")
          throw new ConflictException("只能继续原任务");
        if (
          status === "waiting_input" ||
          run.control.waiting?.value?.type === "retry"
        )
          run.control.resume = command;
        else if (!run.control.resume) run.control.waiting = null;
        status = "queued";
      } else if (kind === "pause") {
        if (status !== "running")
          throw new ConflictException("只有执行中的任务可以暂停");
      } else {
        if (GRAPH_TERMINAL.includes(status))
          throw new ConflictException("任务已经结束");
        status = run.payload.delivery
          ? ["document", "edits"].includes(run.payload.delivery.result.kind)
            ? "awaiting_review"
            : "completed"
          : "stopped";
      }
      run.control.requests = {
        ...run.control.requests,
        [command.request_id]: fingerprint,
      };
      await manager.query(
        "UPDATE agent_runs SET status=?,pause_requested=?,revision=revision+1,control=? WHERE run_id=?",
        [status, kind === "pause", JSON.stringify(run.control), id],
      );
      return row(
        (
          await manager.query("SELECT * FROM agent_runs WHERE run_id=?", [id])
        )[0],
      );
    });
  }

  /**
   * 增加本次执行已使用的资源计数。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param counter 执行次数或用量计数器。
   * @param limit 本次读取或处理的数量上限。
   * @returns 模型和工具调用用量。
   */
  async increment(
    id: string,
    generation: number,
    counter: "execution_turns" | "tool_calls",
    limit: number,
  ) {
    return this.db.transaction(async (manager) => {
      const run = await this.fence(manager, id, generation);
      if (run.budget[counter] >= limit)
        throw new AgentExecutionError(
          "AGENT_BUDGET_EXCEEDED",
          "任务执行预算不足",
        );
      run.budget[counter]++;
      await manager.query("UPDATE agent_runs SET budget=? WHERE run_id=?", [
        JSON.stringify(run.budget),
        id,
      ]);
      return run.budget;
    });
  }

  /**
   * 在发起模型调用前预留资源预算。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   * @param prompt 发送给模型的提示词。
   * @param maxOutput maxOutput 对应的数量或范围限制。
   * @param limits 本次执行的资源与时间上限。
   * @param finalReserve 为最终结果生成预留的额度。
   * @returns 模型和工具调用用量。
   */
  async reserve(
    id: string,
    generation: number,
    prompt: number,
    maxOutput: number,
    limits: { tokens: number; requests: number },
    finalReserve: number,
  ) {
    const estimated = Math.ceil(prompt) + maxOutput,
      reservation = randomUUID();
    const budget = await this.db.transaction(async (manager) => {
      const run = await this.fence(manager, id, generation),
        b = run.budget;
      if (
        b.model_requests >= limits.requests ||
        (b.charged_tokens ?? 0) +
          (b.reserved_tokens ?? 0) +
          estimated +
          finalReserve >
          limits.tokens
      )
        throw new AgentExecutionError(
          "AGENT_BUDGET_EXCEEDED",
          "本次任务的模型预算不足",
        );
      b.model_requests++;
      b.reserved_tokens = (b.reserved_tokens ?? 0) + estimated;
      await manager.query("UPDATE agent_runs SET budget=? WHERE run_id=?", [
        JSON.stringify(b),
        id,
      ]);
      await manager.query(
        "INSERT INTO agent_model_reservations(reservation_id,run_id,generation,estimated) VALUES(?,?,?,?)",
        [reservation, id, generation, estimated],
      );
      return b;
    });
    return { reservation, budget };
  }

  /**
   * 按实际用量结算已经预留的调用预算。
   *
   * @param id 目标记录的唯一标识。
   * @param reservation 调用前预留的预算记录。
   * @param actual 本次实际得到的值（可选）。
   * @returns 模型和工具调用用量。
   */
  async settle(
    id: string,
    reservation: string,
    actual?: { prompt_tokens?: number; completion_tokens?: number },
  ) {
    return this.db.transaction(async (manager) => {
      const run = row(
        (
          await manager.query(
            "SELECT * FROM agent_runs WHERE run_id=? FOR UPDATE",
            [id],
          )
        )[0],
      );
      const [r] = await manager.query(
        "SELECT * FROM agent_model_reservations WHERE reservation_id=? AND run_id=? FOR UPDATE",
        [reservation, id],
      );
      if (!r || r.settled) return run.budget;
      const b = run.budget,
        known =
          Number.isFinite(actual?.prompt_tokens) &&
          Number.isFinite(actual?.completion_tokens);
      b.reserved_tokens = Math.max(
        0,
        (b.reserved_tokens ?? 0) - Number(r.estimated),
      );
      b.charged_tokens =
        (b.charged_tokens ?? 0) +
        (known
          ? Math.max(0, actual!.prompt_tokens!) +
            Math.max(0, actual!.completion_tokens!)
          : Number(r.estimated));
      b.prompt_tokens += known ? actual!.prompt_tokens! : 0;
      b.completion_tokens += known ? actual!.completion_tokens! : 0;
      if (!known) b.estimated_requests = (b.estimated_requests ?? 0) + 1;
      await manager.query("UPDATE agent_runs SET budget=? WHERE run_id=?", [
        JSON.stringify(b),
        id,
      ]);
      await manager.query(
        "UPDATE agent_model_reservations SET settled=TRUE,prompt_tokens=?,completion_tokens=? WHERE reservation_id=?",
        [
          known ? actual!.prompt_tokens : null,
          known ? actual!.completion_tokens : null,
          reservation,
        ],
      );
      return b;
    });
  }

  /**
   * 结算中断执行遗留的预算预留，避免恢复时重复使用额度。
   *
   * @param id 目标记录的唯一标识。
   * @param generation 任务执行代次，用于阻止旧 Worker 写入。
   */
  async settleAbandoned(id: string, generation: number) {
    const rows = await this.db.query<any>(
      "SELECT reservation_id FROM agent_model_reservations WHERE run_id=? AND generation<? AND settled=FALSE",
      [id, generation],
    );
    for (const r of rows) await this.settle(id, r.reservation_id);
  }

  /**
   * 清理已结束或过期操作留下的资源。
   */
  async cleanup() {
    await this.db.transaction(async (manager) => {
      const rows = await manager.query(
        "SELECT run_id FROM agent_runs WHERE graph_version IS NOT NULL AND status NOT IN ('running','queued') AND resumable_until<UTC_TIMESTAMP(6) LIMIT 20 FOR UPDATE SKIP LOCKED",
      );
      for (const r of rows) {
        await manager.query(
          "UPDATE agent_runs SET payload=IF(status IN ('paused','interrupted','waiting_input'),JSON_MERGE_PATCH(payload,CAST(? AS JSON)),payload),status=IF(status IN ('paused','interrupted','waiting_input'),'failed',status),control='{}',resumable_until=NULL WHERE run_id=?",
          [
            JSON.stringify({
              error: "恢复窗口已过期，请重新创建任务",
              failure: { code: "CHECKPOINT_EXPIRED" },
            }),
            r.run_id,
          ],
        );
        for (const table of ["agent_run_artifacts", "agent_run_events"])
          await manager.query(`DELETE FROM ${table} WHERE run_id=?`, [
            r.run_id,
          ]);
        await manager.query(
          "DELETE FROM agent_graph_writes WHERE thread_id=?",
          [r.run_id],
        );
        await manager.query(
          "DELETE FROM agent_graph_checkpoints WHERE thread_id=?",
          [r.run_id],
        );
      }
    });
  }
}
