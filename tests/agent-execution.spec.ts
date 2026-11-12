import { describe, expect, jest, test } from "@jest/globals";
import { ForbiddenException } from "@nestjs/common";
import { AppConfig } from "../src/config/app-config.js";
import { AgentRuntimeService } from "../src/ai/agent-runtime.service.js";
import { AgentAuditService, type AgentRunRecord } from "../src/ai/agent-audit.service.js";
import { AgentExecutionError, agentFailure, reserveModelBudget, reserveWorkerModelBudget, type AgentSpan } from "../src/ai/agent-execution.js";
import { emptyUsage, type WorkerEnvironment } from "../src/ai/agent-runtime.types.js";
import { request } from "./fixtures/agent-request.js";
import { canFallbackModel } from '../src/ai/model-routing.js';

function harness() {
  const config = new AppConfig();
  const llm = { agentTurn: jest.fn<any>(), canFallback: canFallbackModel,
    agentAttempt: () => ({ model: config.llmModel, provider: config.llmProvider, contextWindow: config.llmContextWindow }) };
  const runtime = new AgentRuntimeService(config, llm as any, {} as any, {} as any, {} as any);
  const abort = new AbortController();
  const traces: AgentSpan[] = [];
  const environment: WorkerEnvironment = {
    run_id: "run", task_id: "primary", agent_role: "primary", traces,
    request: request(), context: { user_id: "alice", space_id: "space", team_ids: [] },
    personal: { thinking_supported: false, deployment_web: false } as any,
    signal: abort.signal, budget: emptyUsage(),
    emit: () => {},
  };
  return { llm, runtime, config, abort, traces, environment };
}
const response = { message: { role: "assistant", content: "ok" }, usage: { prompt_tokens: 3, completion_tokens: 2 } };

describe("agent request budgets and failure policy", () => {
  test("worker reservations preserve both memory accounting and durable ledger settlement", async () => {
    const { environment } = harness();
    const limits = { tokens: 100, requests: 3 };
    const settleMemory = await reserveWorkerModelBudget(environment, 10, 20, limits, 5);
    expect(environment.budget).toMatchObject({ reserved_tokens: 30, model_requests: 1 });
    await settleMemory({ prompt_tokens: 8, completion_tokens: 4 });
    expect(environment.budget).toMatchObject({ reserved_tokens: 0, charged_tokens: 12 });

    const settleLedger = jest.fn(async (_actual?: { prompt_tokens?: number; completion_tokens?: number }) => {});
    const reserve = jest.fn<NonNullable<WorkerEnvironment["ledger"]>["reserve"]>().mockResolvedValue(settleLedger);
    environment.ledger = { reserve, increment: jest.fn(async () => {}) };
    const memoryBefore = { ...environment.budget };
    const settle = await reserveWorkerModelBudget(environment, 15, 25, limits, 10);
    expect(reserve).toHaveBeenCalledWith(15, 25, limits, 10);
    const actual = { prompt_tokens: 9, completion_tokens: 6 };
    await settle(actual);
    expect(settleLedger).toHaveBeenCalledWith(actual);
    expect(environment.budget).toEqual(memoryBefore);
  });

  test("parallel reservations cannot overspend, and failed calls retain their estimated charge", () => {
    const usage = emptyUsage();
    const limits = { tokens: 100, requests: 3 };
    const settle = reserveModelBudget(usage, 30, 30, limits, 20);
    expect(() => reserveModelBudget(usage, 10, 20, limits, 20)).toThrow("模型预算不足");
    settle();
    settle({ prompt_tokens: 1, completion_tokens: 1 });
    expect(usage).toMatchObject({ reserved_tokens: 0, charged_tokens: 60, model_requests: 1, estimated_requests: 1 });
    const last = reserveModelBudget(usage, 10, 20, limits);
    last({ prompt_tokens: 8, completion_tokens: 7 });
    expect(usage.charged_tokens).toBe(75);
  });

  test("temporary model failures retry once and produce separate metadata-only spans", async () => {
    const h = harness();
    h.llm.agentTurn.mockRejectedValueOnce(new AgentExecutionError("UPSTREAM_RATE_LIMIT", "busy", true))
      .mockResolvedValueOnce(response);
    await expect(h.runtime.turn(h.environment, [{ role: "user", content: "private prompt" }], []))
      .resolves.toMatchObject({ content: "ok" });
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(2);
    expect(h.environment.budget).toMatchObject({ model_requests: 2, reserved_tokens: 0, estimated_requests: 1 });
    expect(h.traces.map(span => [span.status, span.attributes.attempt])).toEqual([["error", 1], ["success", 2]]);
    expect(JSON.stringify(h.traces)).not.toContain("private prompt");
  });

  test("permission failures do not retry; canceling during retry wait prevents another request", async () => {
    const h = harness();
    h.llm.agentTurn.mockRejectedValue(new ForbiddenException("revoked"));
    await expect(h.runtime.turn(h.environment, [], [])).rejects.toThrow("revoked");
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(1);
    expect(agentFailure(new ForbiddenException())).toEqual({ code: "ACCESS_DENIED", retryable: false });
    h.llm.agentTurn.mockImplementation(async () => {
      queueMicrotask(() => h.abort.abort());
      throw new AgentExecutionError("UPSTREAM_UNAVAILABLE", "busy", true);
    });
    await expect(h.runtime.turn(h.environment, [], [])).rejects.toBeDefined();
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(2);
    expect(h.environment.budget.reserved_tokens).toBe(0);
  });

  test("exhausted token budget prevents an upstream call", async () => {
    const h = harness();
    Object.defineProperty(h.config, "agentMaxTotalTokens", { value: 10 });
    await expect(h.runtime.turn(h.environment, [], [])).rejects.toMatchObject({ code: "AGENT_BUDGET_EXCEEDED" });
    expect(h.llm.agentTurn).not.toHaveBeenCalled();
  });
});

test("a new audit service restores the completed candidate from stored JSON and preserves owner isolation", async () => {
  const rows = new Map<string, any>();
  const db = { metadataEnabled: true, query: jest.fn<any>().mockImplementation(async (sql: string, values: any[]) => {
    if (sql.startsWith("INSERT INTO agent_runs")) {
      const [run_id, request_id, user_id, space_id, conversation_id, mode, status, payload] = values;
      rows.set(run_id, { run_id, request_id, user_id, space_id, conversation_id, mode, status, payload });
    } else if (sql.startsWith("UPDATE agent_runs")) {
      Object.assign(rows.get(values[3]), { status: values[0], payload: values[1] });
    } else if (sql.startsWith("SELECT * FROM agent_runs")) {
      const row = rows.get(values[0]);
      return row && row.user_id === values[1] && row.space_id === values[2] ? [row] : [];
    }
    return [];
  }) };
  const audit = new AgentAuditService(db as any);
  const run: AgentRunRecord = { run_id: "durable", request_id: "request", user_id: "alice", space_id: "space",
    conversation_id: "conversation", mode: "ask", status: "executing", payload: {} };
  await audit.begin(run);
  run.status = "completed";
  run.payload.delivery = { result: { kind: "answer", answer: "saved", citation_ids: [] }, citations: [], candidate_version: 0 };
  await audit.update(run);
  const restarted = new AgentAuditService(db as any);
  const owner = { user_id: "alice", space_id: "space", team_ids: [] };
  expect((await restarted.get("durable", owner)).payload.delivery.result.answer).toBe("saved");
  expect(restarted.isActive("durable")).toBe(false);
  await expect(restarted.get("durable", { ...owner, user_id: "bob" })).rejects.toThrow("任务不存在");
});
