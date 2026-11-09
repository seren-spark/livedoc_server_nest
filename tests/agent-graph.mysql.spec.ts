import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  test,
  expect,
  jest,
} from "@jest/globals";
import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
import { bootstrap } from "../src/main.js";
import { LlmService } from "../src/ai/llm.service.js";
import { AgentRuntimeService } from "../src/ai/agent-runtime.service.js";
import { AgentGraphService } from "../src/ai/graph/agent-graph.service.js";
import {
  AgentRunRepository,
  type GraphRun,
} from "../src/ai/graph/agent-run.repository.js";
import { AgentExecutionError } from "../src/ai/agent-execution.js";
import { ConversationMemoryService } from "../src/ai/memory.service.js";
import { DatabaseService } from "../src/database/database.service.js";
import { request } from "./fixtures/agent-request.js";
import { supervisorResponse } from "./fixtures/supervisor-response.js";
import { handoffArguments } from "./fixtures/worker-handoff.js";
import {
  emptyUsage,
  type WorkerInput,
  type WorkerOutput,
} from "../src/ai/agent-runtime.types.js";
import type { AgentMessage } from "../src/ai/document-agent.types.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { RetrievalService } from "../src/retrieval/retrieval.service.js";
import { WikiService } from "../src/wiki/wiki.service.js";
import { AppConfig } from "../src/config/app-config.js";

const suite =
  process.env.GRAPH_MYSQL_TEST === "true" ? describe : describe.skip;
const aliceContext = {
  user_id: "user_alice",
  space_id: "space_a",
  team_ids: ["team_alpha"],
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function call(name: string, args: unknown) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { prompt_tokens: 8, completion_tokens: 4 },
  };
}
function plain(value: unknown) {
  return {
    message: { role: "assistant" as const, content: JSON.stringify(value) },
    usage: { prompt_tokens: 8, completion_tokens: 4 },
  };
}
function model(
  messages: AgentMessage[],
  _tools?: unknown,
  _signal?: unknown,
  options?: any,
) {
  const supervisor = supervisorResponse(messages);
  if (supervisor) return supervisor;
  if (options?.role === "classifier")
    return plain({ strategy: "react", reason: "single" });
  if (options?.role === "critic") return plain({ passed: true, issues: [] });
  if (options?.role === "plan")
    return plain({
      goal: "改写当前选区",
      outline: ["说明"],
      constraints: [],
      steps: [
        {
          id: "read",
          capability: "read",
          description: "阅读当前选区",
          depends_on: [],
        },
      ],
    });
  const payload = JSON.parse(
    messages.find((m) => m.role === "user")?.content ?? "{}",
  );
  if (payload.step)
    return call(
      "finish_answer",
      handoffArguments({ answer: "资料未记录额外约束", citation_ids: [] }),
    );
  if (
    !messages.some(
      (m) =>
        m.role === "assistant" &&
        m.tool_calls?.some(
          (call) => call.function.name === "read_current_document",
        ),
    )
  )
    return call("read_current_document", { region_ids: [], selection: true });
  if (payload.mode === "ask")
    return call("finish_answer", {
      answer: "已根据当前选区回答",
      citation_ids: [],
    });
  return call("propose_document_edits", {
    edits: [
      {
        id: "edit",
        operation: "replace",
        target: { kind: "selection" },
        content_markdown: "changed",
        explanation: "调整表达",
        citation_ids: [],
      },
    ],
  });
}

suite("LangGraph through real MySQL and HTTP", () => {
  let app: NestFastifyApplication,
    api: ReturnType<typeof supertest>,
    service: AgentGraphService,
    repo: AgentRunRepository;
  let alice: string, bob: string;
  const start = async () => {
    app = await bootstrap();
    await app.getHttpAdapter().getInstance().ready();
    api = supertest(app.getHttpServer());
    service = app.get(AgentGraphService);
    repo = app.get(AgentRunRepository);
    alice = (
      await api
        .post("/dev/auth/login")
        .send({ email: "alice@livedoc.local", password: "Demo@123456" })
    ).body.token;
    bob = (
      await api
        .post("/dev/auth/login")
        .send({ email: "bob@livedoc.local", password: "Demo@123456" })
    ).body.token;
  };
  beforeAll(async () => {
    Logger.overrideLogger(false);
    jest
      .spyOn(AgentGraphService.prototype, "start")
      .mockImplementation(() => undefined);
    await start();
    if (
      !(
        new URL(process.env.DATABASE_URL!).pathname ===
        "/livedoc_langgraph_integration_test"
      )
    )
      throw new Error("Wrong test database");
    const db = app.get(DatabaseService);
    for (const table of [
      "agent_run_events",
      "agent_run_artifacts",
      "agent_model_reservations",
      "agent_graph_writes",
      "agent_graph_checkpoints",
      "agent_runs",
    ])
      await db.query(`DELETE FROM ${table}`);
  }, 120000);
  afterEach(() => {
    jest.restoreAllMocks();
    jest
      .spyOn(AgentGraphService.prototype, "start")
      .mockImplementation(() => undefined);
  });
  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });
  const create = async (mode = "agent") => {
    const input = {
      ...request(mode),
      request_id: randomUUID(),
      conversation_id: randomUUID(),
    };
    const response = await api
      .post("/ai/agent/runs")
      .set("Authorization", `Bearer ${alice}`)
      .send(input)
      .expect(202);
    return { input, id: response.body.run_id as string };
  };
  const until = async (id: string, statuses: string[]): Promise<GraphRun> => {
    const end = Date.now() + 65000;
    while (Date.now() < end) {
      const run = await repo.get(id, aliceContext);
      if (statuses.includes(run.status)) return run;
      if (run.status === "failed") throw new Error(JSON.stringify(run.payload));
      await sleep(150);
    }
    throw new Error(
      `Task did not reach ${statuses}: ${JSON.stringify(await repo.get(id, aliceContext))}`,
    );
  };
  const resume = async (
    run: GraphRun,
    value: Record<string, unknown>,
    operation = randomUUID(),
  ) => {
    const body = {
      request_id: operation,
      expected_revision: run.revision,
      ...(run.control.waiting ? { interrupt_id: run.control.waiting.id } : {}),
      ...value,
    };
    const response = await api
      .post(`/ai/agent/runs/${run.run_id}/resume`)
      .set("Authorization", `Bearer ${alice}`)
      .send(body);
    return { response, body };
  };

  test("plan confirmation keeps run id, survives restart, authorizes execution and deduplicates commands", async () => {
    const spy = jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (...args) => model(...args));
    const { input, id } = await create("plan");
    const duplicate = await api
      .post("/ai/agent/runs")
      .set("Authorization", `Bearer ${alice}`)
      .send(input)
      .expect(202);
    expect(duplicate.body.run_id).toBe(id);
    await service.tick();
    const waiting = await until(id, ["waiting_input"]);
    expect(waiting.control.waiting.value.type).toBe("plan");
    expect(waiting.payload.delivery).toBeUndefined();
    expect(spy.mock.calls.every((args) => args[3]?.role === "plan")).toBe(true);
    const requestsBefore = waiting.budget.model_requests;
    await app.close();
    await start();
    const decisionEntered = deferred<void>(),
      decisionGate = deferred<void>();
    let firstDecision = true;
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (...args) => {
        const payload = JSON.parse(
          args[0].find((message) => message.role === "user")?.content ?? "{}",
        );
        if (firstDecision && payload.purpose === "supervisor") {
          firstDecision = false;
          decisionEntered.resolve();
          await decisionGate.promise;
        }
        return model(...args);
      });
    const restored = await repo.get(id, aliceContext);
    expect(restored.budget.model_requests).toBe(requestsBefore);
    const wrong = await api
      .post(`/ai/agent/runs/${id}/resume`)
      .set("Authorization", `Bearer ${bob}`)
      .send({
        request_id: "wrong",
        expected_revision: restored.revision,
        action: "approve_plan",
      });
    expect(wrong.status).toBe(404);
    const { response, body } = await resume(restored, {
      action: "approve_plan",
      plan: restored.control.waiting.value.plan,
    });
    expect(response.status).toBe(200);
    await api
      .post(`/ai/agent/runs/${id}/resume`)
      .set("Authorization", `Bearer ${alice}`)
      .send(body)
      .expect(200);
    await service.tick();
    await decisionEntered.promise;
    const executing = await repo.get(id, aliceContext);
    await api
      .post(`/ai/agent/runs/${id}/pause`)
      .set("Authorization", `Bearer ${alice}`)
      .send({ request_id: randomUUID(), expected_revision: executing.revision })
      .expect(200);
    decisionGate.resolve();
    const pausedAfterApproval = await until(id, ["paused"]);
    expect(
      (await resume(pausedAfterApproval, { action: "continue" })).response
        .status,
    ).toBe(200);
    await service.tick();
    const done = await until(id, ["awaiting_review"]);
    expect(done.mode).toBe("plan");
    expect(done.payload.delivery.result.kind).toBe("edits");
    expect(done.budget.model_requests).toBeGreaterThan(requestsBefore);
    const restoredDelivery = await api
      .post(`/ai/agent/${id}/restore`)
      .set("Authorization", `Bearer ${alice}`)
      .send({ editor_json: input.editor_snapshot.json })
      .expect(201);
    expect(restoredDelivery.body.payload.delivery.result.edits[0].id).toBe(
      "edit",
    );
    const replay = await api
      .get(`/ai/agent/runs/${id}/events?after_seq=0`)
      .set("Authorization", `Bearer ${alice}`)
      .set("Origin", "http://localhost:5173")
      .expect(200);
    expect(replay.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
    expect(replay.text).toContain("id: ");
    expect(replay.text).not.toContain("source_content");
  }, 120000);

  test("pause drains after current worker; resume reuses completed model calls", async () => {
    const entered = deferred<void>(),
      gate = deferred<void>();
    let count = 0;
    const spy = jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (...args) => {
        count++;
        if (count === 1) {
          entered.resolve();
          await gate.promise;
        }
        return model(...args);
      });
    const { id } = await create("ask");
    await service.tick();
    await entered.promise;
    const current = await repo.get(id, aliceContext);
    await api
      .post(`/ai/agent/runs/${id}/pause`)
      .set("Authorization", `Bearer ${alice}`)
      .send({ request_id: randomUUID(), expected_revision: current.revision })
      .expect(200);
    gate.resolve();
    const paused = await until(id, ["paused"]);
    expect(paused.payload.delivery).toBeUndefined();
    const requests = paused.budget.model_requests,
      calls = spy.mock.calls.length;
    expect((await resume(paused, { action: "continue" })).response.status).toBe(
      200,
    );
    await service.tick();
    const done = await until(id, ["completed"]);
    expect(done.budget.model_requests).toBe(requests);
    expect(spy.mock.calls.length).toBe(calls);
  }, 100000);

  test("shutdown during a model request preserves a resumable task and charged usage", async () => {
    const entered = deferred<void>(),
      gate = deferred<void>();
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (...args) => {
        entered.resolve();
        await gate.promise;
        return model(...args);
      });
    const { id } = await create("ask");
    await service.tick();
    await entered.promise;
    await app.close();
    gate.resolve();
    await start();
    const interrupted = await repo.get(id, aliceContext);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.budget.model_requests).toBe(1);
    expect(interrupted.budget.charged_tokens).toBeGreaterThan(0);
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (...args) => model(...args));
    expect(
      (await resume(interrupted, { action: "continue" })).response.status,
    ).toBe(200);
    await service.tick();
    const done = await until(id, ["completed"]);
    expect(done.budget.model_requests).toBeGreaterThan(1);
  }, 100000);

  test("parallel partial success is not re-executed after recoverable failure", async () => {
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (...args) => model(...args));
    const calls: Record<string, number> = {};
    let fail = true;
    jest
      .spyOn(app.get(AgentRuntimeService), "runWorker")
      .mockImplementation(async (input: WorkerInput) => {
        const key = input.step?.id ?? "primary";
        calls[key] = (calls[key] ?? 0) + 1;
        if (key === "b" && fail) {
          await sleep(200);
          throw new AgentExecutionError(
            "UPSTREAM_NETWORK",
            "controlled failure",
            true,
          );
        }
        const args = handoffArguments({
          answer: "资料未记录更多信息",
          citation_ids: [],
        });
        return {
          result: { kind: "answer", answer: args.answer, citation_ids: [] },
          ...(input.step
            ? { handoff: { ...args.handoff, coverage: "insufficient" } }
            : {}),
          citations: [],
          evidence: [],
          observations: [],
          read_region_ids: [],
          selection_read: false,
          usage: emptyUsage(),
        } as WorkerOutput;
      });
    const input = {
      ...request("ask"),
      request_id: randomUUID(),
      confirmed_plan: {
        goal: "compare",
        outline: [],
        constraints: [],
        steps: ["a", "b"].map((id) => ({
          id,
          capability: "read",
          description: id,
          depends_on: [],
        })),
      },
    };
    const response = await api
      .post("/ai/agent/runs")
      .set("Authorization", `Bearer ${alice}`)
      .send(input)
      .expect(202);
    await service.tick();
    const interrupted = await until(response.body.run_id, ["interrupted"]);
    fail = false;
    expect(
      (await resume(interrupted, { action: "continue" })).response.status,
    ).toBe(200);
    await service.tick();
    await until(response.body.run_id, ["completed"]);
    expect(calls).toEqual({ a: 1, b: 2, primary: 1 });
  }, 100000);

  test("budget reservations are atomic and lost-generation writes are rejected", async () => {
    const input = { ...request(), request_id: randomUUID() };
    const [run, duplicate] = await Promise.all([
      repo.create(input, aliceContext),
      repo.create(input, aliceContext),
    ]);
    expect(duplicate.run_id).toBe(run.run_id);
    const claimed = await repo.claim();
    expect(claimed?.run_id).toBe(run.run_id);
    const g = claimed!.execution_generation;
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        repo.reserve(run.run_id, g, 10, 20, { tokens: 100, requests: 1 }, 0),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      repo.saveArtifact(run.run_id, g - 1, "late", {}),
    ).rejects.toThrow("执行权");
    const before = await repo.internal(run.run_id);
    const reservation = (
      results.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<any>
    ).value.reservation;
    await repo.settle(run.run_id, reservation);
    await repo.settle(run.run_id, reservation, {
      prompt_tokens: 1,
      completion_tokens: 1,
    });
    const after = await repo.internal(run.run_id);
    expect(after.budget.charged_tokens).toBe(30);
    expect(after.budget.model_requests).toBe(before.budget.model_requests);
    const stopped = await repo.command(
      run.run_id,
      aliceContext,
      { request_id: randomUUID(), expected_revision: after.revision },
      "stop",
    );
    expect(stopped.status).toBe("stopped");
    expect(
      (await resume(stopped, { action: "continue" })).response.status,
    ).toBe(409);
  }, 30000);

  test("delivery memory is idempotent and expiry preserves active inputs and stored candidates", async () => {
    const memory = app.get(ConversationMemoryService),
      conversation = randomUUID(),
      source = randomUUID();
    await memory.addTurn(
      conversation,
      "q",
      "a",
      aliceContext,
      undefined,
      source,
    );
    await memory.addTurn(
      conversation,
      "q",
      "a",
      aliceContext,
      undefined,
      source,
    );
    const db = app.get(DatabaseService);
    expect(
      (
        await db.query<any>(
          "SELECT COUNT(*) AS total FROM conversation_turns WHERE conversation_id=?",
          [conversation],
        )
      )[0].total,
    ).toBe("1");
    const run = await repo.create(
      { ...request(), request_id: randomUUID() },
      aliceContext,
    );
    await db.query(
      "UPDATE agent_runs SET resumable_until=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY) WHERE run_id=?",
      [run.run_id],
    );
    await repo.cleanup();
    expect(await repo.artifact(run.run_id, "input")).toBeDefined();
    const claimed = await repo.claim();
    expect(claimed?.run_id).toBe(run.run_id);
    await repo.finish(
      run.run_id,
      claimed!.execution_generation,
      "paused",
      0,
      {},
    );
    await repo.cleanup();
    expect((await repo.internal(run.run_id)).status).toBe("failed");
    await expect(repo.artifact(run.run_id, "input")).rejects.toThrow("失效");
  }, 30000);

  test("a plan supplied by the client cannot bypass Plan confirmation, and old controls conflict", async () => {
    const spy = jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (...args) => model(...args));
    const input = {
      ...request("plan"),
      request_id: randomUUID(),
      confirmed_plan: {
        goal: "改写",
        outline: [],
        constraints: [],
        steps: [
          {
            id: "read",
            description: "阅读",
            capability: "read",
            depends_on: [],
          },
        ],
      },
    };
    const response = await api
      .post("/ai/agent/runs")
      .set("Authorization", `Bearer ${alice}`)
      .send(input)
      .expect(202);
    await service.tick();
    const waiting = await until(response.body.run_id, ["waiting_input"]);
    expect(spy).not.toHaveBeenCalled();
    const first = await resume(waiting, {
      action: "revise_plan",
      text: "补充实现细节",
    });
    expect(first.response.status).toBe(200);
    expect(
      (await resume(waiting, { action: "approve_plan" })).response.status,
    ).toBe(409);
    await service.tick();
    const next = await until(response.body.run_id, ["waiting_input"]);
    expect(next.control.waiting.id).not.toBe(waiting.control.waiting.id);
    jest.replaceProperty(app.get(AppConfig), "agentGraphEnabled", false);
    await api
      .post("/ai/agent/runs")
      .set("Authorization", `Bearer ${alice}`)
      .send({ ...request(), request_id: randomUUID() })
      .expect(404);
    await api
      .post(`/ai/agent/runs/${response.body.run_id}/stop`)
      .set("Authorization", `Bearer ${alice}`)
      .send({ request_id: randomUUID(), expected_revision: next.revision })
      .expect(200);
  }, 80000);

  test("clarification answers resume the same task and are visible to the model", async () => {
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages, tools, signal, options) => {
        if (options?.role === "classifier")
          return plain({ strategy: "react", reason: "single" });
        const payload = JSON.parse(
          messages.find((m) => m.role === "user")?.content ?? "{}",
        );
        if (!Object.keys(payload.clarification_answers ?? {}).length)
          return call("request_clarification", {
            question: "给谁阅读？",
            choices: ["技术评审"],
          });
        return call("finish_answer", {
          answer: `面向${Object.values(payload.clarification_answers)[0]}`,
          citation_ids: [],
        });
      });
    const { id } = await create("ask");
    await service.tick();
    const waiting = await until(id, ["waiting_input"]);
    expect(waiting.control.waiting.value.type).toBe("clarification");
    expect(
      (await resume(waiting, { action: "answer", text: "技术评审" })).response
        .status,
    ).toBe(200);
    await service.tick();
    expect(
      (await until(id, ["completed"])).payload.delivery.result.answer,
    ).toBe("面向技术评审");
  }, 80000);

  test("an unrelated question does not force retrieval just because a knowledge scope is selected", async () => {
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (...args) => model(...args));
    const retrieval = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    const wiki = jest.spyOn(app.get(WikiService), "search");
    const input = {
      ...request("ask"),
      request_id: randomUUID(),
      query: "你好",
      knowledge_scope: {
        private: true,
        public: false,
        team: false,
        document_ids: [],
      },
    };
    const created = await api
      .post("/ai/agent/runs")
      .set("Authorization", `Bearer ${alice}`)
      .send(input)
      .expect(202);
    await service.tick();
    await until(created.body.run_id, ["completed"]);
    expect(retrieval).not.toHaveBeenCalled();
    expect(wiki).not.toHaveBeenCalled();
  }, 60000);

  test.each([false, true])(
    "adaptive retrieval supplements at most once (missing=%s) and preserves source access checks",
    async (missing) => {
      const document = await app.get(DocumentsService).create(
        {
          title: "分块方案",
          content: "方案A固定大小。方案B按标题。",
          visibility: "private",
          source_type: "note",
          tags: [],
          index_now: false,
          asset_ids: [],
        },
        aliceContext,
      );
      jest.spyOn(app.get(WikiService), "search").mockResolvedValue([]);
      jest
        .spyOn(app.get(WikiService), "enqueueCapture")
        .mockImplementation(() => undefined);
      let retrievalCount = 0;
      const retrieval = jest
        .spyOn(app.get(RetrievalService), "searchWithTrace")
        .mockImplementation(
          async () =>
            ({
              citations: [
                {
                  citation_id: `source-${++retrievalCount}`,
                  doc_id: document.doc_id,
                  title: document.title,
                  document_version: 1,
                  content: document.content,
                  source_content: document.content,
                },
              ],
              trace: {},
            }) as any,
        );
      jest
        .spyOn(app.get(LlmService), "agentTurn")
        .mockImplementation(async (messages, tools, signal, options) => {
          const payload = JSON.parse(
            messages.find((m) => m.role === "user")?.content ?? "{}",
          );
          if (payload.purpose === "supervisor") {
            if (
              missing &&
              !payload.ready.length &&
              payload.limits.supplement_remaining > 0
            )
              return plain({
                action: "supplement",
                instruction: "补查方案B的适用场景",
                depends_on: [payload.results[0].id],
              });
            return supervisorResponse(messages)!;
          }
          if (options?.role === "classifier")
            return plain({ strategy: "react", reason: "question" });
          if (payload.step) {
            const arrays = messages
              .filter((m) => m.role === "tool")
              .flatMap((m) => {
                const value = JSON.parse(m.content!);
                return Array.isArray(value) ? value : [];
              });
            if (!arrays.length)
              return call("search_knowledge_base", {
                query: payload.step.description,
              });
            const ids = arrays.map((value) => value.citation_id);
            return call("finish_answer", {
              answer: "已获取方案证据",
              citation_ids: ids,
              handoff: {
                findings: [
                  { statement: "存在两种分块方案", evidence_ids: ids },
                ],
                missing: missing ? ["未记录性能数据"] : [],
                conflicts: [],
              },
            });
          }
          const ids = payload.dependency_evidence.map(
            (e: any) => e.citation.id,
          );
          return call("finish_answer", {
            answer: `方案对比见资料 ${ids.map((id: string) => `[${id}]`).join(" ")}${missing ? "，性能数据未记录。" : ""}`,
            citation_ids: ids,
          });
        });
      const input = {
        ...request("ask"),
        request_id: randomUUID(),
        query: "比较知识库中的分块方案",
        ...(missing
          ? {
              confirmed_plan: {
                goal: "对比分块方案",
                outline: [],
                constraints: [],
                steps: [
                  {
                    id: "supplement",
                    capability: "search" as const,
                    description: "检索已选分块资料",
                    depends_on: [],
                  },
                ],
              },
            }
          : {}),
        knowledge_scope: {
          private: true,
          public: false,
          team: false,
          document_ids: [document.doc_id],
        },
      };
      const response = await api
        .post("/ai/agent/runs")
        .set("Authorization", `Bearer ${alice}`)
        .send(input)
        .expect(202);
      await service.tick();
      const done = await until(response.body.run_id, ["completed"]);
      expect(retrieval).toHaveBeenCalledTimes(missing ? 2 : 1);
      expect(done.payload.supervisor.supplement_count).toBe(missing ? 1 : 0);
      for (const args of retrieval.mock.calls)
        expect(args[0].scope).toMatchObject(input.knowledge_scope);
      expect(done.payload.delivery.citations).toHaveLength(missing ? 2 : 1);
      await app
        .get(DatabaseService)
        .query(
          "UPDATE knowledge_documents SET deleted_at=UTC_TIMESTAMP(6) WHERE doc_id=?",
          [document.doc_id],
        );
      await api
        .post(`/ai/agent/${response.body.run_id}/restore`)
        .set("Authorization", `Bearer ${alice}`)
        .send({ editor_json: input.editor_snapshot.json })
        .expect(404);
      const metadata = await api
        .get(`/ai/agent/runs/${response.body.run_id}`)
        .set("Authorization", `Bearer ${alice}`)
        .expect(200);
      expect(JSON.stringify(metadata.body)).not.toContain(document.content);
    },
    100000,
  );
});
