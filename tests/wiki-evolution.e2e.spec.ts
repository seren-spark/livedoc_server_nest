import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import supertest from "supertest";
import { bootstrap } from "../src/main.js";
import { AppConfig } from "../src/config/app-config.js";
import { LlmService } from "../src/ai/llm.service.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { toIndexRequest } from "../src/documents/document.types.js";
import { RetrievalService } from "../src/retrieval/retrieval.service.js";
import { WikiService } from "../src/wiki/wiki.service.js";
import { request } from "./fixtures/agent-request.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const call = (name: string, args: unknown) => ({
  message: { role: "assistant" as const, content: null, tool_calls: [{
    id: randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) },
  }] }, usage: {},
});

describe("Wiki knowledge changes and derived corrections through the agent API", () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let alice: string, bob: string, carol: string;
  let wiki: WikiService;
  let prefix = "";
  const auth = (token = alice) => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => {
    Logger.overrideLogger(false);
    app = await bootstrap();
    await app.getHttpAdapter().getInstance().ready();
    api = supertest(app.getHttpServer());
    const login = async (email: string) => (await api.post("/dev/auth/login").send({ email, password: "Demo@123456" }).expect(200)).body.token;
    alice = await login("alice@livedoc.local");
    bob = await login("bob@livedoc.local");
    carol = await login("carol@livedoc.local");
    Object.defineProperty(app.get(AppConfig), "llmApiKey", { value: "controlled-model" });
    wiki = app.get(WikiService);
  }, 30000);
  beforeEach(() => {
    prefix = "";
    jest.spyOn(app.get(LlmService), "agentTurn").mockImplementation(async (messages, tools, _signal, options) => {
      const input = JSON.parse(messages.find(message => message.role === "user")!.content!);
      if (options?.role === "plan" && input.sources)
        return { message: { role: "assistant", content: JSON.stringify({
          title: "混合检索知识", markdown: input.answer,
          citation_ids: input.sources.filter((source: any) => input.answer.includes(`[${source.citation_id}]`)).map((source: any) => source.citation_id),
        }) }, usage: {} };
      if (!tools.length)
        return { message: { role: "assistant", content: JSON.stringify({
          passed: true, issues: [], quality: { reusable: true, complete: true, substantive: true },
          coverage: "full", missing: [], strategy: "react", reason: "controlled test",
        }) }, usage: {} };
      const read = messages.find(message => message.role === "tool");
      if (!read) return call("search_knowledge_base", { query: "混合检索知识", original_only: input.query.includes("原文") });
      const sources = JSON.parse(read.content!);
      return call("finish_answer", { answer: `${prefix}${sources[0].content} [${sources[0].citation_id}]`, citation_ids: [sources[0].citation_id] });
    });
  });
  afterEach(async () => { await wiki.waitForCaptures(); jest.restoreAllMocks(); });
  afterAll(async () => { await app.close(); Logger.overrideLogger(["log", "error", "warn", "debug", "verbose", "fatal"]); });

  async function source(token = alice, content = "混合检索：向量和关键词互补，融合去重后重排，选前5条证据。", visibility = "private") {
    const created = (await api.post("/documents").set(auth(token)).send({
      title: `混合检索 ${randomUUID()}`, content, visibility, source_type: "note", index_now: false,
    }).expect(201)).body;
    const document = await app.get(DocumentsService).require(created.doc_id);
    const count = await app.get(RetrievalService).indexDocument(toIndexRequest(document));
    await app.get(DocumentsService).markReady(document.doc_id, count, document.document_version);
    return document.doc_id;
  }
  async function ask(docId?: string, query = "查询混合检索知识", token = alice) {
    const response = await api.post("/ai/agent").set(auth(token)).send({
      ...request("ask"), request_id: randomUUID(), conversation_id: randomUUID(), query,
      knowledge_scope: { private: true, public: false, team: false, document_ids: docId ? [docId] : [] },
    }).expect(200);
    const events = response.text.split("\n\n").filter(frame => frame.includes("data: ")).map(frame => ({
      event: frame.match(/^event: (.+)$/m)![1], data: JSON.parse(frame.split("data: ")[1]!),
    }));
    expect(events.at(-1)!.data.status).toBe("completed");
    expect(events.filter(event => event.event === "result")).toHaveLength(1);
    expect(events.filter(event => event.event === "done")).toHaveLength(1);
    return events[0]!.data.run_id as string;
  }
  const run = async (id: string, token = alice) => (await api.get(`/ai/agent/${id}`).set(auth(token)).expect(200)).body;
  async function saved(id: string, token = alice) {
    await wiki.waitForCaptures();
    const record = await run(id, token);
    expect(record.payload.wiki_capture.status).toBe("published");
    return record.payload.wiki_capture.wiki_id as string;
  }

  test("a newly accessible source forces RAG while foreign/private and unselected domains do not", async () => {
    await source();
    const first = await ask();
    const page = await saved(first);
    const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    await source(bob);
    await source(bob, "无关的公开知识", "public");
    const unaffected = await ask();
    await wiki.waitForCaptures();
    expect(raw).not.toHaveBeenCalled();
    expect((await run(unaffected)).payload.wiki_reads).toContainEqual({ wiki_id: page, revision: 1 });
    await source(alice, "混合检索另一个部署要求最终只选前3条证据，不能沿用前5条。适用不同部署。 ");
    const changed = await ask();
    await wiki.waitForCaptures();
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0]![0].scope.document_ids).toEqual([]);
    expect((await run(changed)).payload.wiki_reads).toEqual([]);
    expect((await api.get(`/ai/wiki/${page}`).set(auth()).expect(200)).body.source_status).toBe("stale");
  });

  test("negative feedback cascades A to B to C, preserving an independently derived answer", async () => {
    const doc = await source();
    const first = await ask(doc);
    const a = await saved(first);
    prefix = "补充整理：";
    const b = await saved(await ask(doc));
    const retrieval = app.get(RetrievalService);
    const search = retrieval.searchWikiWithTrace.bind(retrieval);
    jest.spyOn(retrieval, "searchWikiWithTrace").mockImplementation((input, context, authorize) =>
      search({ ...input, scope: { ...input.scope, document_ids: [b] } }, context, authorize));
    prefix = "进一步整理：";
    const c = await saved(await ask(doc));
    prefix = "原文独立整理：";
    const d = await saved(await ask(doc, "查询混合检索原文"));
    const context = { user_id: "user_alice", space_id: "space_a", team_ids: ["team_alpha"] };
    const { WikiRepository } = await import("../src/wiki/wiki.repository.js");
    const repository = app.get(WikiRepository);
    expect((await repository.get(c, context))?.payload.parents).toEqual(expect.arrayContaining([
      { wiki_id: a, revision: 1 }, { wiki_id: b, revision: 1 },
    ]));
    expect((await repository.get(d, context))?.payload.parents).toEqual([]);
    await api.post(`/ai/agent/${first}/feedback`).set(auth(bob)).send({ action: "incorrect" }).expect(404);
    await api.post(`/ai/agent/${first}/feedback`).set(auth()).send({ action: "incorrect" }).expect(201);
    for (const id of [a, b, c]) await api.get(`/ai/wiki/${id}`).set(auth()).expect(404);
    expect((await api.get(`/ai/wiki/${d}`).set(auth()).expect(200)).body.status).toBe("published");
    expect((await run(first)).status).toBe("completed");
  });

  test("a range change while compiling blocks late publication", async () => {
    await source();
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    const entered = deferred<void>(), release = deferred<void>();
    llm.mockImplementation(async (...args) => {
      if (args[3]?.role === "plan") { entered.resolve(); await release.promise; }
      return regular(...args);
    });
    const id = await ask();
    await entered.promise;
    await source(alice, "混合检索新增适用条件，需要重新核对。");
    release.resolve();
    await wiki.waitForCaptures();
    const record = await run(id);
    expect(record.status).toBe("completed");
    expect(record.payload.wiki_capture.status).toBe("failed");
  });

  test("an unavailable snapshot preserves the original answer and disables automatic capture", async () => {
    const doc = await source();
    jest.spyOn(app.get(DocumentsService), "knowledgeFingerprint").mockRejectedValueOnce(new Error("snapshot unavailable"));
    const search = jest.spyOn(wiki, "search");
    const id = await ask(doc);
    await wiki.waitForCaptures();
    expect((await run(id)).payload.wiki_origin).toBeUndefined();
    expect((await run(id)).payload.wiki_capture).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  test.each(["duplicate", "supplement", "conflict"])("%s knowledge comparison is applied through automatic agent capture", async relation => {
    const doc = await source(carol, "混合检索通过向量语义召回与关键词精确召回互补。两路融合去重后执行重排，最终选择前5条证据。");
    const llm = jest.mocked(app.get(LlmService).agentTurn);
    const regular = llm.getMockImplementation()!;
    llm.mockImplementation(async (...args) => {
      const read = args[0].find(message => message.role === "tool");
      if (args[1].length && read) {
        const sources = JSON.parse(read.content!);
        return call("finish_answer", { answer: `向量语义与关键词精确召回互补。 [${sources[0].citation_id}]`, citation_ids: [sources[0].citation_id] });
      }
      return regular(...args);
    });
    const first = await ask(doc, undefined, carol);
    const oldId = await saved(first, carol);
    const answer = relation === "supplement" ? "重排位于融合去重之后，最终选前5条证据。"
      : relation === "duplicate" ? "语义召回和精确词项匹配相互补充。" : "同一条件下不需要向量召回，只保留关键词。";
    llm.mockImplementation(async (...args) => {
      const payload = JSON.parse(args[0].find(message => message.role === "user")!.content!);
      if (payload.previous_knowledge) {
        const comparison = { wiki_id: payload.previous_knowledge.wiki_id, revision: payload.previous_knowledge.revision, relation };
        const value = args[3]?.role === "plan" ? {
          title: "混合检索知识", markdown: payload.answer,
          citation_ids: [payload.sources[0].citation_id], comparison,
        } : { passed: true, issues: [], quality: { reusable: true, complete: true, substantive: true }, comparison };
        return { message: { role: "assistant", content: JSON.stringify(value) }, usage: { prompt_tokens: 7, completion_tokens: 4 } };
      }
      const read = args[0].find(message => message.role === "tool");
      if (args[1].length && read) {
        const sources = JSON.parse(read.content!);
        return call("finish_answer", { answer: `${answer} [${sources[0].citation_id}]`, citation_ids: [sources[0].citation_id] });
      }
      return regular(...args);
    });
    const second = await ask(doc, "查询混合检索原文", carol);
    await wiki.waitForCaptures();
    const record = await run(second, carol);
    expect(record.status).toBe("completed");
    expect(record.payload.wiki_reads).toEqual([]);
    if (relation === "duplicate") {
      expect(record.payload.wiki_capture).toMatchObject({ status: "skipped", reason: "semantic_duplicate", wiki_id: oldId, revision: 1,
        usage: { model_requests: 2, prompt_tokens: 14, completion_tokens: 8 } });
      await api.post(`/ai/agent/${second}/feedback`).set(auth(carol)).send({ action: "incorrect" }).expect(201);
      await api.get(`/ai/wiki/${oldId}`).set(auth(carol)).expect(404);
    } else if (relation === "supplement") {
      expect(record.payload.wiki_capture.status).toBe("published");
      const id = record.payload.wiki_capture.wiki_id;
      const page = (await api.get(`/ai/wiki/${id}`).set(auth(carol)).expect(200)).body;
      expect(page.topic_id).toBe(oldId);
      expect(page.supersedes).toEqual({ wiki_id: oldId, revision: 1 });
      expect(page.markdown).toContain("向量语义");
      expect(page.markdown).toContain("前5条");
      expect((await api.get(`/ai/wiki/${oldId}`).set(auth(carol)).expect(200)).body.status).toBe("published");
      const third = await ask(doc, undefined, carol);
      await wiki.waitForCaptures();
      expect((await run(third, carol)).payload.wiki_reads).toContainEqual({ wiki_id: id, revision: 1 });
      await api.post(`/ai/agent/${first}/feedback`).set(auth(carol)).send({ action: "incorrect" }).expect(201);
      await api.get(`/ai/wiki/${id}`).set(auth(carol)).expect(404);
    } else {
      expect(record.payload.wiki_capture).toEqual({ status: "skipped", reason: "knowledge_conflict" });
      const page = (await api.get(`/ai/wiki/${oldId}`).set(auth(carol)).expect(200)).body;
      expect(page.source_status).toBe("stale");
      expect(page.markdown).toBeUndefined();
    }
  });
});
