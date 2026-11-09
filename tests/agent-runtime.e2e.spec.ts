import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { Logger, ForbiddenException } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import supertest from "supertest";
import { bootstrap } from "../src/main.js";
import { AppConfig } from "../src/config/app-config.js";
import { LlmService } from "../src/ai/llm.service.js";
import { AgentRuntimeService } from "../src/ai/agent-runtime.service.js";
import { DocumentAgentService } from "../src/ai/document-agent.service.js";
import { AgentAuditService } from "../src/ai/agent-audit.service.js";
import { ConversationMemoryService } from "../src/ai/memory.service.js";
import { RetrievalService } from "../src/retrieval/retrieval.service.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { request } from "./fixtures/agent-request.js";
import { supervisorResponse } from "./fixtures/supervisor-response.js";
import { handoffArguments } from "./fixtures/worker-handoff.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function call(name: string, args: unknown, step = false) {
  if (name === "finish_answer" && step) args = handoffArguments(args);
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: "same",
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  };
}
const frames = (text: string) =>
  text
    .split("\n\n")
    .filter((f) => f.includes("data: "))
    .map((f) => ({
      event: f.match(/^event: (.+)$/m)![1],
      data: JSON.parse(f.split("data: ")[1]!),
    }));
const contextOf = (messages: any[]) =>
  JSON.parse(messages.find((m) => m.role === "user").content);
const outputs = (messages: any[]) =>
  messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));

describe("worker runtime through existing document-agent entry", () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let alice: string;
  let bob: string;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    app = await bootstrap();
    await app.getHttpAdapter().getInstance().ready();
    api = supertest(app.getHttpServer());
    const login = async (email: string) =>
      (
        await api
          .post("/dev/auth/login")
          .send({ email, password: "Demo@123456" })
          .expect(200)
      ).body.token;
    alice = await login("alice@livedoc.local");
    bob = await login("bob@livedoc.local");
    Object.defineProperty(app.get(AppConfig), "llmApiKey", {
      value: "controlled-test-model",
    });
  }, 30000);
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
    Logger.overrideLogger([
      "log",
      "error",
      "warn",
      "debug",
      "verbose",
      "fatal",
    ]);
  });

  test.each(["invalid", "unchanged", "valid", "unavailable"])("reflection %s never releases a known rejected original", async scenario => {
    jest.spyOn(app.get(LlmService), "agentTurn").mockImplementation(async (_messages, _tools, _signal, options) => {
      if (options?.role === "critic") {
        if (scenario === "unavailable") throw new Error("critic offline");
        return { message: { role: "assistant", content: JSON.stringify({ passed: false,
          issues: [{ type: "unsupported_claim", description: "金额没有证据" }] }) }, usage: {} };
      }
      if (options?.json) return { message: { role: "assistant", content: scenario === "invalid" ? "invalid JSON" :
        JSON.stringify({ kind: "document", document_id: "preserved", title: "说明", markdown: scenario === "unchanged" ? "费用是100元" : "资料未记录费用", citation_ids: [] }) }, usage: {} };
      return call("propose_new_document", { title: "说明", markdown: "费用是100元", citation_ids: [] });
    });
    const input = request();
    input.request_id = `reflection-${scenario}`;
    input.output_target = "new_document";
    const response = await api.post("/ai/agent").set("Authorization", `Bearer ${alice}`).send(input).expect(200);
    const events = frames(response.text);
    const result = events.find(frame => frame.event === "result");
    if (["invalid", "unchanged"].includes(scenario)) {
      expect(result).toBeUndefined();
      expect(events.find(frame => frame.event === "error")?.data.code).toBe("AGENT_REVIEW_FAILED");
      expect(events.at(-1)?.data.status).toBe("failed");
      const run = [...app.get(AgentAuditService).runs.values()].find(run => run.request_id === input.request_id)!;
      expect(run.payload.delivery).toBeUndefined();
    } else {
      expect(result?.data.result.markdown).toBe(scenario === "valid" ? "资料未记录费用" : "费用是100元");
      expect(events.find(frame => frame.event === "reflection" && ["revised", "incomplete"].includes(frame.data.status)))
        .toBeDefined();
    }
  });

  test("parallel workers use their roles, cap concurrency at three and emit unique ordered records", async () => {
    const firstBatch = deferred<void>();
    const release = deferred<void>();
    const started: string[] = [];
    const finished: string[] = [];
    const runtime = jest.spyOn(app.get(AgentRuntimeService), "runWorker");
    const memory = jest.spyOn(app.get(ConversationMemoryService), "addTurn");
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages) => {
        const decision = supervisorResponse(messages);
        if (decision) return decision;
        const payload = contextOf(messages);
        if (payload.step) {
          started.push(payload.step.id);
          if (started.length === 3) firstBatch.resolve();
          if (payload.step.id !== "s4") await release.promise;
          else expect(finished).toHaveLength(3);
          expect(payload.step_results).toEqual({});
          finished.push(payload.step.id);
        }
        return call("finish_answer", { answer: "complete", citation_ids: [] }, Boolean(payload.step));
      });
    const input = request("ask");
    input.request_id = "parallel-cap";
    input.confirmed_plan = {
      goal: "research",
      outline: [],
      constraints: [],
      steps: [1, 2, 3, 4].map((i) => ({
        id: `s${i}`,
        description: "研究",
        capability: "search",
        depends_on: [],
      })),
    };
    const pending = api
      .post("/ai/agent")
      .set("Authorization", `Bearer ${alice}`)
      .send(input)
      .then((r) => r);
    await firstBatch.promise;
    try {
      expect(started).toHaveLength(3);
    } finally {
      release.resolve();
    }
    const response = await pending;
    expect(response.status).toBe(200);
    const events = frames(response.text);
    expect(events.filter((e) => e.event === "result")).toHaveLength(1);
    expect(events.filter((e) => e.event === "done")).toHaveLength(1);
    const seq = events.map((e) => e.data.seq);
    expect(seq).toEqual([...new Set(seq)].sort((a, b) => a - b));
    const calls = events
      .filter((e) => e.event === "tool_start")
      .map((e) => e.data.call_id);
    expect(new Set(calls).size).toBe(5);
    expect(
      runtime.mock.calls.filter(([worker]) => worker.role === "researcher"),
    ).toHaveLength(4);
    const done = events.at(-1)!.data;
    expect(done.usage).toMatchObject({
      execution_turns: 8,
      model_requests: 8,
      tool_calls: 5,
      prompt_tokens: 32,
      completion_tokens: 16,
    });
    const audits = await api
      .get(`/ai/tool-audits?run_id=${done.run_id}`)
      .set("Authorization", `Bearer ${alice}`)
      .expect(200);
    expect(audits.body).toHaveLength(5);
    expect(
      audits.body.every(
        (row: any) => row.status === "success" && row.payload.task_id,
      ),
    ).toBe(true);
    expect(memory).toHaveBeenCalledTimes(1);
  });

  test("a failed prerequisite prevents its dependent and the final candidate from running", async () => {
    const called: string[] = [];
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages) => {
        const decision = supervisorResponse(messages);
        if (decision) return decision;
        const payload = contextOf(messages);
        called.push(payload.step?.id ?? "primary");
        return call("search_knowledge_base", { query: "reader cannot search" });
      });
    const input = request("ask");
    input.request_id = "failed-dependency";
    input.confirmed_plan = {
      goal: "x",
      outline: [],
      constraints: [],
      steps: [
        { id: "a", description: "读取", capability: "read", depends_on: [] },
        {
          id: "b",
          description: "研究",
          capability: "search",
          depends_on: ["a"],
        },
      ],
    };
    const response = await api
      .post("/ai/agent")
      .set("Authorization", `Bearer ${alice}`)
      .send(input)
      .expect(200);
    expect(called).toEqual(["a", "a"]);
    expect(frames(response.text).some((e) => e.event === "result")).toBe(false);
    expect(frames(response.text).at(-1)!.data.status).toBe("failed");
  });

  test("only completed dependencies enter context and concurrent owners remain isolated", async () => {
    const histories: Record<string, string[]> = {
      "owner-a": [],
      "owner-b": [],
    };
    const bothStarted = deferred<void>();
    let ownersStarted = 0;
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages) => {
        const decision = supervisorResponse(messages);
        if (decision) return decision;
        const payload = contextOf(messages);
        const key = payload.query as keyof typeof histories;
        histories[key]!.push(JSON.stringify(messages));
        const read = outputs(messages)[0];
        if (payload.step?.id === "read" && !read) {
          if (++ownersStarted === 2) bothStarted.resolve();
          await bothStarted.promise;
          return call("read_reference", { reference_id: "note" });
        }
        if (payload.step?.id === "read")
          return call("finish_answer", {
            answer: read.content,
            citation_ids: [read.citation_id],
          }, true);
        expect(payload.step_results.read).toContain(
          key === "owner-a" ? "alice secret" : "bob secret",
        );
        expect(payload.dependency_evidence[0].content).toBe(
          key === "owner-a" ? "alice secret" : "bob secret",
        );
        return call("finish_answer", {
          answer: payload.step_results.read,
          citation_ids: [payload.dependency_evidence[0].citation.id],
        }, Boolean(payload.step));
      });
    const run = async (owner: string, token: string, content: string) => {
      const input = request("ask");
      input.query = owner;
      input.request_id = `isolation-${owner}`;
      input.references = [
        { id: "note", kind: "text", title: "notes", content },
      ];
      input.confirmed_plan = {
        goal: "x",
        outline: [],
        constraints: [],
        steps: [
          {
            id: "read",
            description: "读取",
            capability: "read",
            depends_on: [],
          },
          {
            id: "research",
            description: "分析",
            capability: "search",
            depends_on: ["read"],
          },
        ],
      };
      return api
        .post("/ai/agent")
        .set("Authorization", `Bearer ${token}`)
        .send(input)
        .expect(200);
    };
    const [a, b] = await Promise.all([
      run("owner-a", alice, "alice secret"),
      run("owner-b", bob, "bob secret"),
    ]);
    expect(a.text).not.toContain("bob secret");
    expect(b.text).not.toContain("alice secret");
    expect(histories["owner-a"]!.join("\n")).not.toContain("bob secret");
    expect(histories["owner-b"]!.join("\n")).not.toContain("alice secret");
    expect(frames(a.text).at(-1)!.data.status).toBe("completed");
    await api
      .get(`/ai/agent/${frames(a.text)[0]!.data.run_id}`)
      .set("Authorization", `Bearer ${bob}`)
      .expect(404);
  });

  test.each(["revoked", "version"])(
    "final source revalidation prevents publication after %s",
    async (kind) => {
      let changed = false;
      jest
        .spyOn(app.get(DocumentsService), "getAccessible")
        .mockImplementation(async () => {
          if (changed && kind === "revoked")
            throw new ForbiddenException("access revoked");
          return {
            doc_id: "source",
            title: "source",
            content: "trusted source",
            document_version: changed ? 2 : 1,
          } as any;
        });
      jest
        .spyOn(app.get(LlmService), "agentTurn")
        .mockImplementation(async (messages) => {
          const decision = supervisorResponse(messages);
          if (decision) return decision;
          const payload = contextOf(messages);
          const read = outputs(messages)[0];
          if (payload.step && !read)
            return call("read_reference", { reference_id: "note" });
          if (payload.step)
            return call("finish_answer", {
              answer: "source",
              citation_ids: [read.citation_id],
            }, true);
          changed = true;
          return call("finish_answer", {
            answer: "answer",
            citation_ids: [payload.dependency_evidence[0].citation.id],
          });
        });
      const input = request("ask");
      input.request_id = `source-${kind}`;
      input.references = [
        { id: "note", kind: "document", doc_id: "source", title: "source" },
      ];
      input.confirmed_plan = {
        goal: "x",
        outline: [],
        constraints: [],
        steps: [
          {
            id: "read",
            description: "读取",
            capability: "read",
            depends_on: [],
          },
        ],
      };
      const response = await api
        .post("/ai/agent")
        .set("Authorization", `Bearer ${alice}`)
        .send(input)
        .expect(200);
      expect(frames(response.text).some((e) => e.event === "result")).toBe(
        false,
      );
      expect(frames(response.text).at(-1)!.data.status).toBe("failed");
    },
  );

  test("canceling a pending retrieval seals events and rejects late results without saving memory", async () => {
    const entered = deferred<void>();
    const release = deferred<any>();
    const settled = deferred<void>();
    jest
      .spyOn(app.get(RetrievalService), "searchWithTrace")
      .mockImplementation(async () => {
        entered.resolve();
        const result = await release.promise;
        settled.resolve();
        return result;
      });
    const model = jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(
        async (messages) =>
          supervisorResponse(messages) ??
          call("search_knowledge_base", { query: "x" }),
      );
    const memory = jest.spyOn(app.get(ConversationMemoryService), "addTurn");
    const input = request("ask");
    input.request_id = "cancel-retrieval";
    input.knowledge_scope = {
      private: true,
      public: false,
      team: false,
      document_ids: [],
    };
    input.confirmed_plan = {
      goal: "x",
      outline: [],
      constraints: [],
      steps: [
        {
          id: "search",
          description: "检索",
          capability: "search",
          depends_on: [],
        },
        {
          id: "next",
          description: "后续",
          capability: "search",
          depends_on: ["search"],
        },
      ],
    };
    const abort = new AbortController();
    const events: any[] = [];
    const owner = { user_id: "cancel-owner", space_id: "space", team_ids: [] };
    const consume = (async () => {
      for await (const event of app
        .get(DocumentAgentService)
        .run(input, owner, abort.signal))
        events.push(event);
    })();
    await entered.promise;
    abort.abort(new Error("user stopped"));
    await consume;
    const count = events.length;
    expect(events.at(-1).data.status).toBe("stopped");
    release.resolve({
      citations: [{ citation_id: "late", content: "late secret" }],
    });
    await settled.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(count);
    expect(events.some((e) => e.event === "result")).toBe(false);
    expect(model).toHaveBeenCalledTimes(2);
    expect(memory).not.toHaveBeenCalled();
    const runId = events[0].data.run_id;
    expect((await app.get(AgentAuditService).get(runId, owner)).status).toBe(
      "stopped",
    );
    expect(
      (await app.get(AgentAuditService).list(runId, owner)).every(
        (row: any) => row.status !== "success",
      ),
    ).toBe(true);
  });

  test("supervisor supplements once and delivers both original and supplemental evidence to the final agent", async () => {
    const memory = jest.spyOn(app.get(ConversationMemoryService), "addTurn");
    const seen: any[] = [];
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages) => {
        const payload = contextOf(messages);
        if (payload.purpose === "supervisor") {
          seen.push(payload);
          expect(JSON.stringify(payload)).not.toContain("source_content");
          if (payload.results.length === 1) expect(payload.results[0].handoff).toMatchObject({
            coverage: "partial", missing: ["第二份资料尚未核实"],
          });
          const action = !payload.results.length
            ? { action: "dispatch", task_ids: ["read"] }
            : payload.results.length === 1
              ? {
                  action: "supplement",
                  instruction: "读取第二份资料核实缺口",
                  depends_on: ["read"],
                }
              : { action: "compose" };
          return {
            message: { role: "assistant", content: JSON.stringify(action) },
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          };
        }
        if (payload.step) {
          const read = outputs(messages)[0];
          if (!read)
            return call("read_reference", {
              reference_id: payload.step.id === "read" ? "first" : "second",
            });
          if (payload.step.id !== "read") {
            expect(payload.step.depends_on).toEqual(["read"]);
            expect(payload.dependency_evidence[0].content).toBe(
              "first source proof",
            );
            expect(payload.dependency_handoffs.read.missing).toEqual(["第二份资料尚未核实"]);
          }
          return call("finish_answer", {
            answer: "validated fact",
            citation_ids: [read.citation_id],
            handoff: { findings: [{ statement: "validated fact", evidence_ids: [read.citation_id] }],
              missing: payload.step.id === "read" ? ["第二份资料尚未核实"] : [], conflicts: [] },
          });
        }
        expect(Object.keys(payload.step_results)).toHaveLength(2);
        expect(payload.dependency_handoffs.read.coverage).toBe("partial");
        expect(
          payload.dependency_evidence.map((item: any) => item.content),
        ).toEqual(["first source proof", "second source proof"]);
        return call("finish_answer", {
          answer: "supported answer",
          citation_ids: payload.dependency_evidence.map(
            (item: any) => item.citation.id,
          ),
        });
      });
    const input = request("ask");
    input.request_id = "supervisor-supplement";
    input.references = [
      {
        id: "first",
        kind: "text",
        title: "first",
        content: "first source proof",
      },
      {
        id: "second",
        kind: "text",
        title: "second",
        content: "second source proof",
      },
    ];
    input.confirmed_plan = {
      goal: "核实两份资料",
      outline: [],
      constraints: ["只读"],
      steps: [
        {
          id: "read",
          capability: "read",
          description: "读取第一份资料",
          depends_on: [],
        },
      ],
    };
    const original = structuredClone(input.confirmed_plan);
    const response = await api
      .post("/ai/agent")
      .set("Authorization", `Bearer ${bob}`)
      .send(input)
      .expect(200);
    const events = frames(response.text);
    const result = events.find((event) => event.event === "result")!;
    expect(result.data.citations).toHaveLength(2);
    expect(events.at(-1)!.data.status).toBe("completed");
    expect(events.filter((event) => event.event === "done")).toHaveLength(1);
    expect(seen).toHaveLength(3);
    expect(
      seen.every(
        (payload) => JSON.stringify(payload.plan) === JSON.stringify(original),
      ),
    ).toBe(true);
    const audit = await api
      .get(`/ai/agent/${result.data.run_id}`)
      .set("Authorization", `Bearer ${bob}`)
      .expect(200);
    expect(audit.body.payload.supervisor).toMatchObject({
      status: "completed",
      supplement_count: 1,
      repair_count: 0,
    });
    expect(audit.body.payload.tasks.map((task: any) => task.role)).toEqual([
      "reader",
      "researcher",
      "primary",
    ]);
    expect(audit.body.payload.tasks[0].handoff).toEqual({ coverage: "partial", findings: 1, missing: 1, conflicts: 0 });
    expect(JSON.stringify(audit.body)).not.toContain("第二份资料尚未核实");
    expect(memory).toHaveBeenCalledTimes(1);
  });

  test("supervisor clarification returns needs_input without starting a worker", async () => {
    const worker = jest.spyOn(app.get(AgentRuntimeService), "runWorker");
    jest.spyOn(app.get(LlmService), "agentTurn").mockResolvedValue({
      message: {
        role: "assistant",
        content: JSON.stringify({
          action: "clarify",
          question: "请指定资料范围",
          choices: ["当前正文", "所选资料"],
        }),
      },
      usage: {},
    });
    const input = request("ask");
    input.request_id = "supervisor-clarify";
    input.confirmed_plan = {
      goal: "research",
      outline: [],
      constraints: [],
      steps: [
        { id: "read", capability: "read", description: "read", depends_on: [] },
      ],
    };
    const response = await api
      .post("/ai/agent")
      .set("Authorization", `Bearer ${bob}`)
      .send(input)
      .expect(200);
    expect(
      frames(response.text).find((event) => event.event === "result")!.data
        .result.kind,
    ).toBe("clarification");
    expect(frames(response.text).at(-1)!.data.status).toBe("needs_input");
    expect(worker).not.toHaveBeenCalled();
  });

  test("supervisor cannot skip confirmed steps by repeatedly requesting compose", async () => {
    const worker = jest.spyOn(app.get(AgentRuntimeService), "runWorker");
    const model = jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockResolvedValue({
        message: { role: "assistant", content: '{"action":"compose"}' },
        usage: {},
      });
    const input = request("ask");
    input.request_id = "supervisor-skip";
    input.confirmed_plan = {
      goal: "research",
      outline: [],
      constraints: [],
      steps: [
        { id: "read", capability: "read", description: "read", depends_on: [] },
      ],
    };
    const response = await api
      .post("/ai/agent")
      .set("Authorization", `Bearer ${bob}`)
      .send(input)
      .expect(200);
    expect(
      frames(response.text).some((event) => event.event === "result"),
    ).toBe(false);
    expect(frames(response.text).at(-1)!.data.status).toBe("failed");
    expect(model).toHaveBeenCalledTimes(2);
    expect(worker).not.toHaveBeenCalled();
  });

  test("automatically planned work enters the supervisor and passes its execution plan to the final agent", async () => {
    const plan = {
      goal: "automatic",
      outline: [],
      constraints: ["read only"],
      steps: [
        { id: "read", capability: "read", description: "read", depends_on: [] },
      ],
    };
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages, _tools, _signal, options) => {
        const decision = supervisorResponse(messages);
        if (decision) return decision;
        if (options?.role === "plan")
          return {
            message: { role: "assistant", content: JSON.stringify(plan) },
            usage: {},
          };
        const payload = contextOf(messages);
        expect(payload.execution_plan).toEqual(plan);
        return call("finish_answer", { answer: "complete", citation_ids: [] }, Boolean(payload.step));
      });
    const input = request("ask");
    input.request_id = "supervisor-auto-plan";
    input.query = "先读取，然后回答";
    const response = await api
      .post("/ai/agent")
      .set("Authorization", `Bearer ${bob}`)
      .send(input)
      .expect(200);
    const events = frames(response.text);
    expect(events.at(-1)!.data.status).toBe("completed");
    expect(
      events.some(
        (event) =>
          event.data.agent_role === "supervisor" &&
          event.data.action === "dispatch",
      ),
    ).toBe(true);
  });

  test("canceling a supervisor model request discards its late decision", async () => {
    const entered = deferred<void>();
    const release = deferred<any>();
    const model = jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async () => {
        entered.resolve();
        return release.promise;
      });
    const worker = jest.spyOn(app.get(AgentRuntimeService), "runWorker");
    const memory = jest.spyOn(app.get(ConversationMemoryService), "addTurn");
    const input = request("ask");
    input.request_id = "supervisor-cancel";
    input.confirmed_plan = {
      goal: "research",
      outline: [],
      constraints: [],
      steps: [
        { id: "read", capability: "read", description: "read", depends_on: [] },
      ],
    };
    const abort = new AbortController();
    const owner = {
      user_id: "supervisor-cancel-owner",
      space_id: "space",
      team_ids: [],
    };
    const events: any[] = [];
    const consume = (async () => {
      for await (const event of app
        .get(DocumentAgentService)
        .run(input, owner, abort.signal))
        events.push(event);
    })();
    await entered.promise;
    abort.abort(new Error("user stopped"));
    await consume;
    const count = events.length;
    release.resolve({
      message: {
        role: "assistant",
        content: '{"action":"dispatch","task_ids":["read"]}',
      },
      usage: {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(count);
    expect(events.at(-1).data.status).toBe("stopped");
    expect(worker).not.toHaveBeenCalled();
    expect(memory).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledTimes(1);
    const run = await app
      .get(AgentAuditService)
      .get(events[0].data.run_id, owner);
    expect(run.payload.supervisor.status).toBe("canceled");
  });
});
