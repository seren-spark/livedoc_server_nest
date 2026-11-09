import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import supertest from "supertest";
import { bootstrap } from "../src/main.js";
import { AppConfig } from "../src/config/app-config.js";
import { AgentAuditService } from "../src/ai/agent-audit.service.js";
import { LlmService } from "../src/ai/llm.service.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { toIndexRequest } from "../src/documents/document.types.js";
import { RetrievalService } from "../src/retrieval/retrieval.service.js";
import { WikiService, wikiHash } from "../src/wiki/wiki.service.js";
import { WikiRepository } from "../src/wiki/wiki.repository.js";
import type { WikiPage } from "../src/wiki/wiki.types.js";
import { request } from "./fixtures/agent-request.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const call = (name: string, args: unknown) => ({
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
  usage: {},
});
const frames = (raw: string) =>
  raw
    .split("\n\n")
    .filter((frame) => frame.includes("data: "))
    .map((frame) => ({
      event: frame.match(/^event: (.+)$/m)![1]!,
      data: JSON.parse(frame.split("data: ")[1]!),
    }));

describe("automatic wiki capture after completed agent answers", () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let token: string;
  let bob: string;
  let carol: string;
  let wiki: WikiService;
  const auth = (authToken = token) => ({
    Authorization: `Bearer ${authToken}`,
  });
  beforeAll(async () => {
    Logger.overrideLogger(false);
    app = await bootstrap();
    await app.getHttpAdapter().getInstance().ready();
    api = supertest(app.getHttpServer());
    token = (
      await api
        .post("/dev/auth/login")
        .send({ email: "alice@livedoc.local", password: "Demo@123456" })
    ).body.token;
    bob = (
      await api
        .post("/dev/auth/login")
        .send({ email: "bob@livedoc.local", password: "Demo@123456" })
    ).body.token;
    carol = (
      await api
        .post("/dev/auth/login")
        .send({ email: "carol@livedoc.local", password: "Demo@123456" })
    ).body.token;
    Object.defineProperty(app.get(AppConfig), "llmApiKey", {
      value: "controlled-model",
    });
    wiki = app.get(WikiService);
  }, 30000);
  beforeEach(() => {
    jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages, tools, _signal, options) => {
        const input = JSON.parse(
          messages.find((message) => message.role === "user")!.content!,
        );
        if (options?.role === "plan" && input.sources) {
          const id = input.sources[0].citation_id;
          return {
            message: {
              role: "assistant",
              content: JSON.stringify({
                title: "混合检索知识",
                markdown: `向量与关键词互补。 [${id}]`,
                citation_ids: [id],
              }),
            },
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        }
        if (!tools.length)
          return {
            message: {
              role: "assistant",
              content:
                '{"passed":true,"issues":[],"quality":{"reusable":true,"complete":true,"substantive":true},"coverage":"full","missing":[],"strategy":"react","reason":"test"}',
            },
            usage: {},
          };
        const read = messages.find((message) => message.role === "tool");
        if (!read)
          return call("search_knowledge_base", {
            query: input.query,
            original_only: input.query.includes("原文"),
          });
        const sources = JSON.parse(read.content!);
        return call("finish_answer", {
          answer: `向量与关键词互补。 [${sources[0].citation_id}]`,
          citation_ids: [sources[0].citation_id],
        });
      });
  });
  afterEach(async () => {
    await wiki.waitForCaptures();
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

  async function source(authToken = token, content = "混合检索：向量与关键词互补。") {
    const created = (
      await api
        .post("/documents")
        .set(auth(authToken))
        .send({
          title: `混合检索 ${randomUUID()}`,
          content,
          visibility: "private",
          source_type: "note",
          index_now: false,
        })
        .expect(201)
    ).body;
    const record = await app.get(DocumentsService).require(created.doc_id);
    const count = await app
      .get(RetrievalService)
      .indexDocument(toIndexRequest(record));
    await app
      .get(DocumentsService)
      .markReady(record.doc_id, count, record.document_version);
    return record;
  }
  function input(docId: string, query = "查询混合检索知识") {
    return {
      ...request("ask"),
      request_id: randomUUID(),
      conversation_id: randomUUID(),
      query,
      knowledge_scope: {
        private: true,
        public: false,
        team: false,
        document_ids: [docId],
      },
    };
  }
  async function ask(docId: string, query?: string, authToken = token) {
    const response = await api
      .post("/ai/agent")
      .set(auth(authToken))
      .send(input(docId, query))
      .expect(200);
    const events = frames(response.text);
    expect(events.at(-1)!.data.status).toBe("completed");
    expect(events.filter((event) => event.event === "done")).toHaveLength(1);
    expect(events.filter((event) => event.event === "result")).toHaveLength(1);
    return {
      events,
      run_id: events[0]!.data.run_id,
      result: events.find((event) => event.event === "result")!.data,
    };
  }
  async function capture(runId: string, authToken = token) {
    return (
      await api.get(`/ai/agent/${runId}`).set(auth(authToken)).expect(200)
    ).body;
  }

  test("two indexed Wiki pages jointly answer one request with distinct original citations and audited proofs", async () => {
    const marker = `union-${randomUUID()}`;
    const parts = ["召回规则：向量与关键词互补。", "重排规则：并列时按编号升序排列。"];
    const doc = await source(carol, parts.join("\n\n"));
    const context = { user_id: doc.owner_id!, space_id: doc.space_id, team_ids: [] };
    const snapshot = await wiki.knowledgeSnapshot(input(doc.doc_id).knowledge_scope, context);
    const ids: string[] = [];
    for (const [index, text] of parts.entries()) {
      const id = `wiki_${randomUUID().replaceAll("-", "")}`;
      const now = new Date();
      const page: WikiPage = { wiki_id: id, owner_id: context.user_id, space_id: context.space_id,
        origin_run_id: randomUUID(), revision: 1, status: "published", created_at: now, updated_at: now,
        payload: { title: `${marker} 混合检索 ${index}`, question: "混合检索", markdown: `${text} [same-label]`,
          knowledge_snapshot: snapshot, parents: [], review: { passed: true, issues: [] },
          usage: { model_requests: 0, prompt_tokens: 0, completion_tokens: 0 }, sources: [{
            citation_id: "same-label", doc_id: doc.doc_id, version: doc.document_version, title: doc.title,
            start_offset: doc.content.indexOf(text), end_offset: doc.content.indexOf(text) + text.length,
            excerpt_hash: wikiHash(text),
          }] } };
      await app.get(WikiRepository).insert(page);
      await app.get(RetrievalService).indexDocument({ ...toIndexRequest(doc), doc_id: id,
        title: page.payload.title, content: page.payload.markdown, knowledge_layer: "wiki", document_version: 1 });
      ids.push(id);
    }
    jest.spyOn(wiki, "enqueueCapture").mockImplementation(() => undefined);
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    let checks = 0;
    llm.mockImplementation(async (...args) => {
      const payload = JSON.parse(args[0].find(message => message.role === "user")!.content!);
      if (payload.knowledge) {
        checks++;
        expect(payload.knowledge.pages.map((page: any) => page.wiki_id).sort()).toEqual([...ids].sort());
        return { message: { role: "assistant", content: '{"coverage":"full","missing":[]}' }, usage: {} };
      }
      const read = args[0].find(message => message.role === "tool");
      if (read) {
        const rows = JSON.parse(read.content!);
        expect(new Set(rows.map((row: any) => row.citation_id)).size).toBe(2);
        return call("finish_answer", { answer: rows.map((row: any) => `${row.content} [${row.citation_id}]`).join("\n"),
          citation_ids: rows.map((row: any) => row.citation_id) });
      }
      return regular(...args);
    });
    const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    const result = await ask(doc.doc_id, `查询 ${marker} 混合检索的召回和重排规则`, carol);
    const audit = await capture(result.run_id, carol);
    expect(checks).toBe(1);
    expect(raw).not.toHaveBeenCalled();
    expect(audit.payload.wiki_reads.map((proof: any) => proof.wiki_id).sort()).toEqual([...ids].sort());
    expect(result.result.citations.map((citation: any) => citation.source_content).sort()).toEqual([...parts].sort());
    const tools = (await api.get(`/ai/tool-audits?run_id=${result.run_id}`).set(auth(carol)).expect(200)).body;
    expect(tools.find((tool: any) => tool.tool_name === "search_knowledge_base")?.payload.wiki_coverage[0])
      .toMatchObject({ coverage: "full", missing: [], wiki_ids: expect.arrayContaining(ids) });
  });

  test("responds before background compilation, automatically publishes, then reuses without any confirmation request", async () => {
    const doc = await source();
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    const entered = deferred<void>();
    const release = deferred<void>();
    llm.mockImplementation(async (...args) => {
      if (args[3]?.role === "plan") {
        entered.resolve();
        await release.promise;
      }
      return regular(...args);
    });
    const first = await ask(doc.doc_id);
    await entered.promise;
    expect((await capture(first.run_id)).status).toBe("completed");
    const before = (await api.get("/ai/wiki").set(auth()).expect(200)).body
      .items;
    expect(before).toEqual([]);
    release.resolve();
    await wiki.waitForCaptures();
    const audit = await capture(first.run_id);
    expect(audit.payload.wiki_capture.status).toBe("published");
    expect(audit.payload.wiki_capture.usage.model_requests).toBe(2);
    const page = (
      await api
        .get(`/ai/wiki/${audit.payload.wiki_capture.wiki_id}`)
        .set(auth())
        .expect(200)
    ).body;
    expect(page.status).toBe("published");
    await api
      .get(`/ai/wiki/${page.wiki_id}`)
      .set({ Authorization: `Bearer ${bob}` })
      .expect(404);
    const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    const second = await ask(doc.doc_id, "查询语义召回与精确关键词互补的知识");
    await wiki.waitForCaptures();
    expect(raw).not.toHaveBeenCalled();
    expect(second.result.citations[0].doc_id).toBe(doc.doc_id);
    expect((await capture(second.run_id)).payload.wiki_capture).toMatchObject({
      status: "skipped",
      reason: "wiki_reused",
    });
    expect(
      llm.mock.calls.filter((args) => args[3]?.role === "plan"),
    ).toHaveLength(1);
    const third = await ask(doc.doc_id, "查询混合检索原文知识");
    await wiki.waitForCaptures();
    expect((await capture(third.run_id)).payload.wiki_capture).toMatchObject({
      status: "skipped",
      reason: "already_compiled",
      wiki_id: page.wiki_id,
    });
  });

  test("failed review leaves the delivered answer completed and creates no reusable knowledge", async () => {
    const doc = await source();
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    llm.mockImplementation(async (...args) =>
      args[3]?.role === "critic"
        ? {
            message: {
              role: "assistant",
              content: '{"passed":false,"issues":["unsupported"]}',
            },
            usage: {},
          }
        : regular(...args),
    );
    const answer = await ask(doc.doc_id);
    await wiki.waitForCaptures();
    const audit = await capture(answer.run_id);
    expect(audit.status).toBe("completed");
    expect(audit.payload.wiki_capture).toMatchObject({
      status: "failed",
      reason: "capture_failed",
    });
    expect(audit.payload.result_kind).toBe("answer");
  });

  test("index failure cannot publish or change the root terminal status", async () => {
    const doc = await source();
    jest
      .spyOn(app.get(RetrievalService), "indexDocument")
      .mockRejectedValue(new Error("index unavailable"));
    const answer = await ask(doc.doc_id);
    await wiki.waitForCaptures();
    const audit = await capture(answer.run_id);
    expect(audit.status).toBe("completed");
    expect(audit.payload.wiki_capture.status).toBe("failed");
    const pages = (await api.get("/ai/wiki").set(auth()).expect(200)).body
      .items;
    expect(
      pages.some(
        (page: any) =>
          page.status === "failed" && page.title === "混合检索知识",
      ),
    ).toBe(true);
  });

  test("source changes while compiling prevent automatic publication", async () => {
    const doc = await source();
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    const entered = deferred<void>();
    const release = deferred<void>();
    llm.mockImplementation(async (...args) => {
      if (args[3]?.role === "plan") {
        entered.resolve();
        await release.promise;
      }
      return regular(...args);
    });
    const answer = await ask(doc.doc_id);
    await entered.promise;
    await api
      .patch(`/documents/${doc.doc_id}`)
      .set(auth())
      .send({ expected_version: 1, content: "更新后的原文" })
      .expect(200);
    release.resolve();
    await wiki.waitForCaptures();
    const audit = await capture(answer.run_id);
    expect(audit.status).toBe("completed");
    expect(audit.payload.wiki_capture.status).toBe("failed");
  });

  test("cancelling the main request never schedules automatic knowledge capture", async () => {
    const doc = await source();
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    const entered = deferred<void>();
    const release = deferred<void>();
    llm.mockImplementation(async (...args) => {
      if (args[0].some((message) => message.role === "tool")) {
        entered.resolve();
        await release.promise;
      }
      return regular(...args);
    });
    const enqueue = jest.spyOn(wiki, "enqueueCapture");
    const auditService = app.get(AgentAuditService);
    const update = auditService.update.bind(auditService);
    const stopped = deferred<void>();
    jest.spyOn(auditService, "update").mockImplementation(async (run) => {
      await update(run);
      if (run.status === "stopped") stopped.resolve();
    });
    const pending = api.post("/ai/agent").set(auth()).send(input(doc.doc_id));
    const finished = pending.then(
      () => undefined,
      () => undefined,
    );
    await entered.promise;
    pending.abort();
    await stopped.promise;
    release.resolve();
    await finished;
    await wiki.waitForCaptures();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("the first model call cannot bypass Wiki-first by setting original_only", async () => {
    const doc = await source(bob);
    await ask(doc.doc_id, undefined, bob);
    await wiki.waitForCaptures();
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    llm.mockImplementation(async (...args) => {
      if (args[1].some(tool => tool.function.name === "search_knowledge_base") && !args[0].some(message => message.role === "tool"))
        return call("search_knowledge_base", { query: "混合检索知识", original_only: true });
      return regular(...args);
    });
    const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    const result = await ask(doc.doc_id, "查询混合检索知识的互补关系", bob);
    await wiki.waitForCaptures();
    expect(raw).not.toHaveBeenCalled();
    expect((await capture(result.run_id, bob)).payload.wiki_reads).toHaveLength(1);
  });

  test("quality rejection skips a sourced but non-reusable answer", async () => {
    const doc = await source(bob);
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    llm.mockImplementation(async (...args) => {
      const payload = JSON.parse(
        args[0].find((message) => message.role === "user")!.content!,
      );
      if (args[3]?.role === "critic" && payload.candidate)
        return {
          message: {
            role: "assistant",
            content:
              '{"passed":true,"issues":[],"quality":{"reusable":false,"complete":true,"substantive":false}}',
          },
          usage: {},
        };
      return regular(...args);
    });
    const result = await ask(doc.doc_id, undefined, bob);
    await wiki.waitForCaptures();
    expect((await capture(result.run_id, bob)).payload.wiki_capture).toEqual({
      status: "skipped",
      reason: "quality_rejected",
    });
  });

  test.each(["partial", "unavailable"])(
    "%s coverage retrieves originals and preserves only verified partial knowledge",
    async (verdict) => {
      const doc = await source(bob);
      const seeded = await ask(doc.doc_id, undefined, bob);
      await wiki.waitForCaptures();
      const pageId = (await capture(seeded.run_id, bob)).payload.wiki_capture
        .wiki_id;
      expect(pageId).toBeTruthy();
      const llm = jest.mocked(app.get(LlmService).agentTurn);
      const regular = llm.getMockImplementation()!;
      llm.mockImplementation(async (...args) => {
        const payload = JSON.parse(
          args[0].find((message) => message.role === "user")!.content!,
        );
        if (payload.knowledge) {
          if (verdict === "unavailable") throw new Error("judge unavailable");
          return {
            message: {
              role: "assistant",
              content: '{"coverage":"partial","missing":["对比信息"]}',
            },
            usage: { prompt_tokens: 12, completion_tokens: 6 },
          };
        }
        return regular(...args);
      });
      const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
      const result = await ask(doc.doc_id, "查询混合检索知识并解释局限", bob);
      await wiki.waitForCaptures();
      expect(raw).toHaveBeenCalledTimes(1);
      expect(raw.mock.calls[0]![0].scope.document_ids).toEqual([doc.doc_id]);
      expect(raw.mock.calls[0]![0].query.includes("对比信息")).toBe(verdict === "partial");
      expect(result.result.citations[0].doc_id).toBe(doc.doc_id);
      const audit = await capture(result.run_id, bob);
      expect(audit.payload.wiki_reads).toEqual(verdict === "partial" ? [{ wiki_id: pageId, revision: 1 }] : []);
      expect(audit.payload.usage.model_requests).toBeGreaterThanOrEqual(3);
      const tools = (
        await api
          .get(`/ai/tool-audits?run_id=${result.run_id}`)
          .set(auth(bob))
          .expect(200)
      ).body;
      expect(
        tools.some((tool: any) =>
          tool.payload.wiki_coverage?.some(
            (item: any) => item.wiki_id === pageId && item.coverage === verdict &&
              (verdict === "partial" ? item.missing[0] === "对比信息" : item.reason === "judge_unavailable"),
          ),
        ),
      ).toBe(true);
    },
  );

  test("answer feedback is scoped and rejection withdraws reused knowledge without changing the answer", async () => {
    const doc = await source(bob);
    const first = await ask(doc.doc_id, undefined, bob);
    await wiki.waitForCaptures();
    const pageId = (await capture(first.run_id, bob)).payload.wiki_capture
      .wiki_id;
    const reused = await ask(doc.doc_id, "查询混合检索知识的互补作用", bob);
    await wiki.waitForCaptures();
    const endpoint = `/ai/agent/${reused.run_id}/feedback`;
    await api
      .post(endpoint)
      .set(auth())
      .send({ action: "incorrect" })
      .expect(404);
    await api
      .post(endpoint)
      .set(auth(bob))
      .send({ action: "incorrect", edit_id: "forged" })
      .expect(400);
    await api
      .post(endpoint)
      .set(auth(bob))
      .send({ action: "helpful" })
      .expect(201);
    await api
      .post(endpoint)
      .set(auth(bob))
      .send({ action: "incorrect" })
      .expect(201);
    await api.get(`/ai/wiki/${pageId}`).set(auth(bob)).expect(404);
    await api
      .post(endpoint)
      .set(auth(bob))
      .send({ action: "helpful" })
      .expect(409);
    const audit = await capture(reused.run_id, bob);
    expect(audit.status).toBe("completed");
    expect(audit.payload.feedback.answer).toBe("incorrect");
  });

  test("negative feedback cancels pending compilation and late model output cannot publish", async () => {
    const doc = await source(bob);
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    const entered = deferred<void>();
    const release = deferred<void>();
    llm.mockImplementation(async (...args) => {
      if (args[3]?.role === "plan") {
        entered.resolve();
        await release.promise;
      }
      return regular(...args);
    });
    const result = await ask(doc.doc_id, undefined, bob);
    await entered.promise;
    await api
      .post(`/ai/agent/${result.run_id}/feedback`)
      .set(auth(bob))
      .send({ action: "incorrect" })
      .expect(201);
    release.resolve();
    await wiki.waitForCaptures();
    const audit = await capture(result.run_id, bob);
    expect(audit.status).toBe("completed");
    expect(audit.payload.wiki_capture).toEqual({
      status: "skipped",
      reason: "user_rejected",
    });
  });

  test("freshness-sensitive answers and answers without document evidence do not auto-compile", async () => {
    const doc = await source();
    const enqueue = jest.spyOn(wiki, "enqueueCapture");
    await ask(doc.doc_id, "查询最新混合检索知识");
    jest.mocked(app.get(LlmService).agentTurn).mockResolvedValue(
      call("finish_answer", {
        answer: "无需来源的一般说明。",
        citation_ids: [],
      }),
    );
    await ask(doc.doc_id);
    await wiki.waitForCaptures();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("Wiki query failure still completes through scoped RAG without tool repair", async () => {
    const doc = await source(carol);
    jest.spyOn(wiki, "search").mockRejectedValue(new Error("private Wiki diagnostic"));
    const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    const result = await ask(doc.doc_id, undefined, carol);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0]![0].scope.document_ids).toEqual([doc.doc_id]);
    expect(raw.mock.calls[0]![1].user_id).toBe("user_carol");
    expect(result.result.citations.map((citation: any) => citation.doc_id)).toEqual([doc.doc_id]);
    expect(result.events.filter(event => event.event === "tool_result" && event.data.status === "error")).toEqual([]);
    const tools = (await api.get(`/ai/tool-audits?run_id=${result.run_id}`).set(auth(carol)).expect(200)).body;
    expect(tools.some((tool: any) => tool.payload.wiki_fallback?.includes("unavailable"))).toBe(true);
    expect(JSON.stringify(tools)).not.toContain("private Wiki diagnostic");
    expect((await capture(result.run_id, carol)).payload.wiki_reads).toEqual([]);
  });

  test.each([true, false])("a new fact in the same original chunk goes through quality review (passed=%s)", async (passed) => {
    const doc = await source(carol, "混合检索：向量与关键词互补。重排在融合去重之后执行，最终选前5条证据。");
    const first = await ask(doc.doc_id, undefined, carol);
    await wiki.waitForCaptures();
    const seeded = (await capture(first.run_id, carol)).payload.wiki_capture.wiki_id;
    expect(seeded).toBeTruthy();
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    let compiles = 0;
    llm.mockImplementation(async (...args) => {
      const payload = JSON.parse(args[0].find(message => message.role === "user")!.content!);
      if (args[3]?.role === "plan" && payload.sources) {
        compiles++;
        const id = payload.sources[0].citation_id;
        return {
          message: { role: "assistant", content: JSON.stringify({
            title: "混合检索重排", markdown: `重排在融合去重之后执行，最终选前5条证据。 [${id}]`, citation_ids: [id],
          }) }, usage: {},
        };
      }
      if (args[3]?.role === "critic" && payload.candidate)
        return { message: { role: "assistant", content: JSON.stringify({
          passed: true, issues: [], quality: { reusable: passed, complete: true, substantive: true },
        }) }, usage: {} };
      if (args[1].length) {
        const reads = args[0].filter(message => message.role === "tool");
        if (!reads.length)
          return call("search_knowledge_base", { query: "混合检索知识", original_only: payload.query.includes("原文") });
        const sources = JSON.parse(reads.at(-1)!.content!);
        if (sources[0].knowledge_layer === "wiki")
          return call("search_knowledge_base", { query: "混合检索重排顺序和证据条数", original_only: true });
        const id = sources[0].citation_id;
        return call("finish_answer", {
          answer: `重排在融合去重之后执行，最终选前5条证据。 [${id}]`, citation_ids: [id],
        });
      }
      return regular(...args);
    });
    const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    const second = await ask(doc.doc_id, "查询混合检索重排顺序和证据条数", carol);
    await wiki.waitForCaptures();
    const firstAudit = await capture(first.run_id, carol);
    const audit = await capture(second.run_id, carol);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(audit.payload.wiki_reads).toContainEqual({ wiki_id: seeded, revision: 1 });
    const positions = (sources: any[]) => sources.map(({ citation_id: _id, ...source }) => source);
    expect(positions(audit.payload.wiki_origin.sources)).toEqual(positions(firstAudit.payload.wiki_origin.sources));
    expect(compiles).toBe(1);
    if (passed) {
      expect(audit.payload.wiki_capture.status).toBe("published");
      expect(audit.payload.wiki_capture.wiki_id).not.toBe(seeded);
      const page = (await api.get(`/ai/wiki/${audit.payload.wiki_capture.wiki_id}`).set(auth(carol)).expect(200)).body;
      expect(page.markdown).toContain("最终选前5条");
      // The same answer and source fingerprint still deduplicates without compiling again.
      const repeated = await ask(doc.doc_id, "查询混合检索重排原文", carol);
      await wiki.waitForCaptures();
      expect((await capture(repeated.run_id, carol)).payload.wiki_capture.reason).toBe("already_compiled");
      expect(compiles).toBe(1);
    } else {
      expect(audit.payload.wiki_capture).toEqual({ status: "skipped", reason: "quality_rejected" });
    }
    expect((await api.get(`/ai/wiki/${seeded}`).set(auth(carol)).expect(200)).body.status).toBe("published");
  });
});
