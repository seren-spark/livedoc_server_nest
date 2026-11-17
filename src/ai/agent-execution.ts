/**
 * @file Agent 执行控制。统一执行错误、资源预算和阶段耗时，供 Runtime 与图工作流共用。
 */
import { HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AgentUsage, WorkerEnvironment } from "./agent-runtime.types.js";

export class AgentExecutionError extends Error {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param code 错误标识或待解析的代码内容。
   * @param message 当前消息内容。
   * @param retryable 该失败是否允许重试。
   */
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

/**
 * 将异常与取消状态转换为前后端统一的 Agent 失败信息。
 *
 * @param error 本次操作捕获的异常。
 * @param signal 取消信号，用于中止请求和后台处理（可选）。
 * @returns 整理后的状态与操作结果对象。
 */
export function agentFailure(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) {
    const timeout = signal.reason?.name === "TimeoutError";
    return { code: timeout ? "AGENT_TIMEOUT" : "AGENT_STOPPED", retryable: false };
  }
  if (error instanceof AgentExecutionError)
    return { code: error.code, retryable: error.retryable };
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 403 || status === 401 ? "ACCESS_DENIED"
      : status === 404 ? "SOURCE_UNAVAILABLE" : status === 409 ? "SOURCE_CHANGED"
      : status === 429 ? "UPSTREAM_RATE_LIMIT" : status >= 500 ? "UPSTREAM_UNAVAILABLE" : "INVALID_INPUT";
    return { code, retryable: status === 429 || status === 502 || status === 503 || status === 504 };
  }
  const value = error as { name?: string; cause?: { code?: string }; code?: string } | null;
  if (value?.name === "TimeoutError") return { code: "AGENT_TIMEOUT", retryable: false };
  if (["EACCES", "EPERM"].includes(value?.cause?.code ?? value?.code ?? ""))
    return { code: "UPSTREAM_NETWORK_DENIED", retryable: false };
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]
    .includes(value?.cause?.code ?? value?.code ?? ""))
    return { code: "UPSTREAM_NETWORK", retryable: true };
  return { code: "AGENT_FAILED", retryable: false };
}

/**
 * 在发起并行模型调用前同步预留额度；用量未知时保留已计入的额度。
 *
 *  Reserve synchronously before parallel calls; unknown provider usage keeps its reservation charged.
 *
 * @param usage 已使用或待累计的模型与工具用量。
 * @param promptTokens promptTokens 对应的 Token 数量或预算。
 * @param maxOutput maxOutput 对应的数量或范围限制。
 * @param limits 本次执行的资源与时间上限。
 * @param finalizationReserve 为最终汇总和交付预留的调用额度。
 * @returns 供后续操作使用的回调或清理函数。
 */
export function reserveModelBudget(
  usage: AgentUsage, promptTokens: number, maxOutput: number,
  limits: { tokens: number; requests: number }, finalizationReserve = 0,
) {
  const reservation = Math.ceil(promptTokens) + maxOutput;
  if (usage.model_requests >= limits.requests ||
    (usage.charged_tokens ?? 0) + (usage.reserved_tokens ?? 0) + reservation + finalizationReserve > limits.tokens)
    throw new AgentExecutionError("AGENT_BUDGET_EXCEEDED", "本次任务的模型预算不足，请缩小任务范围");
  usage.reserved_tokens = (usage.reserved_tokens ?? 0) + reservation;
  usage.model_requests++;
  let settled = false;
  return (actual?: { prompt_tokens?: number; completion_tokens?: number }) => {
    if (settled) return;
    settled = true;
    usage.reserved_tokens! -= reservation;
    const known = Number.isFinite(actual?.prompt_tokens) && Number.isFinite(actual?.completion_tokens);
    usage.charged_tokens = (usage.charged_tokens ?? 0) + (known
      ? Math.max(0, actual!.prompt_tokens!) + Math.max(0, actual!.completion_tokens!) : reservation);
    if (!known) usage.estimated_requests = (usage.estimated_requests ?? 0) + 1;
  };
}

/**
 * 优先使用持久化任务账本预留 Worker 预算，否则使用内存预算。
 *
 *  Use the run's durable ledger when available, otherwise its in-memory budget.
 *
 * @param environment 当前 Worker 的身份、预算、能力与事件出口。
 * @param promptTokens promptTokens 对应的 Token 数量或预算。
 * @param maxOutput maxOutput 对应的数量或范围限制。
 * @param limits 本次执行的资源与时间上限。
 * @param finalizationReserve 为最终汇总和交付预留的调用额度。
 * @returns 供后续操作使用的回调或清理函数。
 */
export async function reserveWorkerModelBudget(
  environment: WorkerEnvironment,
  promptTokens: number,
  maxOutput: number,
  limits: { tokens: number; requests: number },
  finalizationReserve = 0,
) {
  return environment.ledger
    ? environment.ledger.reserve(promptTokens, maxOutput, limits, finalizationReserve)
    : reserveModelBudget(environment.budget, promptTokens, maxOutput, limits, finalizationReserve);
}

export interface AgentSpan {
  span_id: string;
  parent_span_id: string;
  kind: "worker" | "supervisor" | "model" | "tool";
  name: string;
  status: "running" | "success" | "error" | "canceled";
  started_at: string;
  duration_ms?: number;
  task_id?: string;
  agent_role?: string;
  attributes: Record<string, string | number | boolean>;
  error_code?: string;
}

/**
 * 记录执行阶段的开始时间，返回用于收尾和记录结果的追踪对象。
 *
 * @param environment 当前 Worker 的身份、预算、能力与事件出口。
 * @param kind 当前结果或来源的分类。
 * @param name 目标名称。
 * @param attributes 节点或 DOM 使用的属性。
 * @returns 整理后的状态与操作结果对象。
 */
export function startAgentSpan(environment: WorkerEnvironment, kind: AgentSpan["kind"], name: string,
  attributes: AgentSpan["attributes"] = {}) {
  const start = performance.now();
  const span: AgentSpan = {
    span_id: randomUUID(), parent_span_id: environment.parent_span_id ?? environment.run_id,
    kind, name, status: "running", started_at: new Date().toISOString(),
    task_id: environment.task_id, agent_role: environment.agent_role, attributes,
  };
  environment.traces?.push(span);
  return {
    span,
    /**
     * 结束当前执行阶段，记录耗时、成功或失败状态与错误码。
     *
     * @param error 本次操作捕获的异常（可选）。
     */
    finish(error?: unknown) {
      span.duration_ms = Math.round(performance.now() - start);
      span.status = error === undefined ? "success" : environment.signal.aborted ? "canceled" : "error";
      if (error !== undefined) span.error_code = agentFailure(error, environment.signal).code;
    },
  };
}
