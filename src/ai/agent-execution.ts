import { HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AgentUsage, WorkerEnvironment } from "./agent-runtime.types.js";

export class AgentExecutionError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

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

/** Reserve synchronously before parallel calls; unknown provider usage keeps its reservation charged. */
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

/** Use the run's durable ledger when available, otherwise its in-memory budget. */
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
    finish(error?: unknown) {
      span.duration_ms = Math.round(performance.now() - start);
      span.status = error === undefined ? "success" : environment.signal.aborted ? "canceled" : "error";
      if (error !== undefined) span.error_code = agentFailure(error, environment.signal).code;
    },
  };
}
