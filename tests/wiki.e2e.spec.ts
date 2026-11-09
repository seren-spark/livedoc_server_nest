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
import { LlmService } from "../src/ai/llm.service.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { toIndexRequest } from "../src/documents/document.types.js";
import { RetrievalService } from "../src/retrieval/retrieval.service.js";
import { WikiService } from "../src/wiki/wiki.service.js";
import { request } from "./fixtures/agent-request.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const frames = (text: string) =>
  text
    .split("\n\n")
    .filter((frame) => frame.includes("data: "))
    .map((frame) => ({
      event: frame.match(/^event: (.+)$/m)![1],
      data: JSON.parse(frame.split("data: ")[1]!),
    }));
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

describe("verified private wiki through real agent and knowledge APIs", () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let alice: string;
  let bob: string;
  const auth = (token = alice) => ({ Authorization: `Bearer ${token}` });
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
      value: "controlled-model",
    });
  }, 30000);
  afterEach(() => {
    jest.restoreAllMocks();
  });
  // Retained manual API compatibility cases isolate capture; automatic orchestration
  // is exercised separately against the real enqueue path in wiki-auto.e2e.spec.ts.
  beforeEach(() => {
    jest
      .spyOn(app.get(WikiService), "enqueueCapture")
      .mockImplementation(() => {});
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

  function model(originalOnly = false) {
    return jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages, _tools, _signal, options) => {
        const payload = JSON.parse(
          messages.find((message) => message.role === "user")!.content!,
        );
        if (options?.role === "plan") {
          const id = payload.sources[0].citation_id;
          return {
            message: {
              role: "assistant",
              content: JSON.stringify({
                title: "混合检索的设计",
                markdown: `# 混合检索\n\n向量和关键词检索互补。 [${id}]`,
                citation_ids: [id],
              }),
            },
            usage: {},
          };
        }
        if (options?.role === "critic")
          return {
            message: {
              role: "assistant",
              content:
                '{"passed":true,"issues":[],"quality":{"reusable":true,"complete":true,"substantive":true},"coverage":"full","missing":[]}',
            },
            usage: {},
          };
        const read = messages.find((message) => message.role === "tool");
        if (!read)
          return call("search_knowledge_base", {
            query: payload.query,
            ...(originalOnly ? { original_only: true } : {}),
          });
        const sources = JSON.parse(read.content!);
        if (!Array.isArray(sources))
          throw new Error(`Unexpected tool response: ${read.content}`);
        expect(sources.length).toBeGreaterThan(0);
        return call("finish_answer", {
          answer: `向量和关键词检索互补。 [${sources[0].citation_id}]`,
          citation_ids: [sources[0].citation_id],
        });
      });
  }
  async function source(token = alice, visibility = "private") {
    const doc = (
      await api
        .post("/documents")
        .set(auth(token))
        .send({
          title: `混合检索 ${randomUUID()}`,
          content: "混合检索的设计：向量和关键词检索互补。",
          visibility,
          source_type: "note",
          index_now: false,
        })
        .expect(201)
    ).body;
    const record = await app.get(DocumentsService).require(doc.doc_id);
    const count = await app
      .get(RetrievalService)
      .indexDocument(toIndexRequest(record));
    await app
      .get(DocumentsService)
      .markReady(doc.doc_id, count, record.document_version);
    return record;
  }
  async function answer(
    docId: string,
    query = "查询混合检索的设计",
    token = alice,
  ) {
    const input = request("ask");
    input.request_id = randomUUID();
    input.conversation_id = randomUUID();
    input.query = query;
    input.knowledge_scope = {
      private: true,
      public: true,
      team: false,
      document_ids: [docId],
    };
    const response = await api
      .post("/ai/agent")
      .set(auth(token))
      .send(input)
      .expect(200);
    const events = frames(response.text);
    const result = events.find((event) => event.event === "result");
    if (!result)
      throw new Error(
        events.find((event) => event.event === "error")?.data.message ??
          response.text,
      );
    expect(events.at(-1)!.data.status).toBe("completed");
    return {
      events,
      run_id: result!.data.run_id,
      answer: result!.data.result.answer,
      available: result!.data.wiki_available,
      result: result!.data,
    };
  }
  async function draft(docId: string, token = alice) {
    const origin = await answer(docId, "查询混合检索的设计", token);
    expect(origin.available).toBe(true);
    return (
      await api
        .post("/ai/wiki/candidates")
        .set(auth(token))
        .send({ run_id: origin.run_id, answer: origin.answer })
        .expect(201)
    ).body;
  }

  test("a confirmed page is indexed and reused with original evidence, while raw-only and fresh questions bypass it", async () => {
    const llm = model();
    const doc = await source();
    const page = await draft(doc.doc_id);
    expect(page.status).toBe("draft");
    await api
      .post("/documents")
      .set(auth(bob))
      .send({
        doc_id: page.wiki_id,
        title: "collision",
        content: "forged source",
        source_type: "note",
        index_now: false,
      })
      .expect(400);
    const scope = {
      private: true,
      public: false,
      team: false,
      document_ids: [doc.doc_id],
    };
    const owner = {
      user_id: doc.owner_id!,
      space_id: doc.space_id,
      team_ids: [],
    };
    expect(
      await app
        .get(WikiService)
        .search(
          "向量关键词混合检索",
          scope,
          owner,
          new AbortController().signal,
        ),
    ).toEqual([]);
    await api
      .post(`/ai/wiki/${page.wiki_id}/publish`)
      .set(auth())
      .send({ revision: 1 })
      .expect(201);
    const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    const used = await answer(doc.doc_id, "查询向量与关键词如何互补的知识");
    expect(raw).not.toHaveBeenCalled();
    expect(
      used.events.some(
        (event) =>
          event.event === "tool_result" &&
          event.data.summary.includes("整理知识"),
      ),
    ).toBe(true);
    expect(used.result.citations[0].doc_id).toBe(doc.doc_id);
    expect(used.result.citations[0].source_content).toContain(
      "向量和关键词检索互补",
    );
    const lastHistory = llm.mock.calls.at(-1)![0];
    expect(
      lastHistory.some(
        (message) =>
          message.role === "tool" &&
          message.content?.includes('"knowledge_layer":"wiki"'),
      ),
    ).toBe(true);
    llm.mockRestore();
    model(true);
    await answer(doc.doc_id, "查询混合检索原文");
    expect(raw).toHaveBeenCalledTimes(1);
    await answer(doc.doc_id, "查询最新混合检索资料");
    expect(raw).toHaveBeenCalledTimes(2);
    const direct = await app.get(RetrievalService).searchWithTrace(
      {
        query: "混合检索",
        top_k: 10,
        mode: "hybrid",
        context: "",
        scope: {
          private: true,
          public: false,
          team: false,
          document_ids: [],
        },
      } as any,
      owner,
    );
    expect(
      direct.citations.every(
        (citation) => !citation.doc_id.startsWith("wiki_"),
      ),
    ).toBe(true);
    await api.get(`/ai/wiki/${page.wiki_id}`).set(auth(bob)).expect(404);
  });

  test("changed sources redact the old page and force raw retrieval, including before publish", async () => {
    model();
    const doc = await source();
    const page = await draft(doc.doc_id);
    await api
      .post(`/ai/wiki/${page.wiki_id}/publish`)
      .set(auth())
      .send({ revision: 1 })
      .expect(201);
    const updated = (
      await api
        .patch(`/documents/${doc.doc_id}`)
        .set(auth())
        .send({
          expected_version: 1,
          content: "混合检索新版：仍然使用向量和关键词，新增重排。",
        })
        .expect(200)
    ).body;
    const current = await app.get(DocumentsService).require(doc.doc_id);
    await app
      .get(DocumentsService)
      .markReady(
        doc.doc_id,
        await app.get(RetrievalService).indexDocument(toIndexRequest(current)),
        current.document_version,
      );
    const stale = (
      await api.get(`/ai/wiki/${page.wiki_id}`).set(auth()).expect(200)
    ).body;
    expect(stale.source_status).toBe("stale");
    expect(stale.markdown).toBeUndefined();
    expect(stale.citations).toEqual([]);
    await api
      .post(`/ai/wiki/${page.wiki_id}/publish`)
      .set(auth())
      .send({ revision: 1 })
      .expect(409);
    const raw = jest.spyOn(app.get(RetrievalService), "searchWithTrace");
    const result = await answer(doc.doc_id);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(result.result.citations[0].version).toBe(updated.document_version);
  });

  test("source revocation hides body and source titles, and deletion stops reuse", async () => {
    model();
    const doc = await source(bob, "public");
    const page = await draft(doc.doc_id);
    await api
      .post(`/ai/wiki/${page.wiki_id}/publish`)
      .set(auth())
      .send({ revision: 1 })
      .expect(201);
    await api
      .patch(`/documents/${doc.doc_id}`)
      .set(auth(bob))
      .send({ expected_version: 1, visibility: "private" })
      .expect(200);
    const hidden = await api
      .get(`/ai/wiki/${page.wiki_id}`)
      .set(auth())
      .expect(200);
    expect(hidden.body.source_status).toBe("unavailable");
    expect(hidden.text).not.toContain(doc.title);
    expect(hidden.body.markdown).toBeUndefined();
    await api.get(`/ai/wiki/${page.wiki_id}`).set(auth(bob)).expect(404);
    await api.delete(`/ai/wiki/${page.wiki_id}`).set(auth()).expect(200);
    await api.get(`/ai/wiki/${page.wiki_id}`).set(auth()).expect(404);
    const list = (await api.get("/ai/wiki").set(auth()).expect(200)).body;
    expect(list.items.some((item: any) => item.wiki_id === page.wiki_id)).toBe(
      false,
    );
  });

  test("tampered answers, forged origins and other owners are rejected before model calls", async () => {
    const llm = model();
    const doc = await source();
    const origin = await answer(doc.doc_id);
    llm.mockClear();
    await api
      .post("/ai/wiki/candidates")
      .set(auth())
      .send({ run_id: origin.run_id, answer: `${origin.answer} forged` })
      .expect(400);
    await api
      .post("/ai/wiki/candidates")
      .set(auth(bob))
      .send({ run_id: origin.run_id, answer: origin.answer })
      .expect(404);
    await api
      .post("/ai/wiki/candidates")
      .set(auth())
      .send({
        run_id: origin.run_id,
        answer: origin.answer,
        sources: [{ doc_id: "forged" }],
      })
      .expect(422);
    expect(llm).not.toHaveBeenCalled();
  });

  test("a failed independent source review cannot produce a savable candidate", async () => {
    const llm = model();
    const doc = await source();
    const origin = await answer(doc.doc_id);
    const before = (await api.get("/ai/wiki").set(auth()).expect(200)).body
      .items.length;
    llm.mockImplementation(async (messages, _tools, _signal, options) => {
      if (options?.role === "critic")
        return {
          message: {
            role: "assistant",
            content: '{"passed":false,"issues":["unsupported claim"]}',
          },
          usage: {},
        };
      const payload = JSON.parse(messages[1]!.content!);
      const id = payload.sources[0].citation_id;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            title: "bad candidate",
            markdown: `unsupported [${id}]`,
            citation_ids: [id],
          }),
        },
        usage: {},
      };
    });
    await api
      .post("/ai/wiki/candidates")
      .set(auth())
      .send({ run_id: origin.run_id, answer: origin.answer })
      .expect(400);
    expect(
      (await api.get("/ai/wiki").set(auth()).expect(200)).body.items,
    ).toHaveLength(before);
  });

  test("stopping a pending non-cancelable index cannot publish its late result", async () => {
    model();
    const doc = await source();
    const page = await draft(doc.doc_id);
    const entered = deferred<void>();
    const release = deferred<number>();
    jest
      .spyOn(app.get(RetrievalService), "indexDocument")
      .mockImplementation(async () => {
        entered.resolve();
        return release.promise;
      });
    const abort = new AbortController();
    const owner = {
      user_id: doc.owner_id!,
      space_id: doc.space_id,
      team_ids: [],
    };
    const work = app
      .get(WikiService)
      .publish(page.wiki_id, 1, owner, abort.signal);
    const rejected = expect(work).rejects.toThrow("stopped");
    await entered.promise;
    abort.abort(new Error("stopped"));
    await rejected;
    release.resolve(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      (await api.get(`/ai/wiki/${page.wiki_id}`).set(auth()).expect(200)).body
        .status,
    ).toBe("failed");
  });

  test("removing a wiki during generation blocks final publication despite still-readable original sources", async () => {
    const llm = model();
    const doc = await source(bob);
    const page = await draft(doc.doc_id, bob);
    await api
      .post(`/ai/wiki/${page.wiki_id}/publish`)
      .set(auth(bob))
      .send({ revision: 1 })
      .expect(201);
    const entered = deferred<void>();
    const release = deferred<void>();
    const regular = llm.getMockImplementation()!;
    llm.mockImplementation(async (...args) => {
      const tool = args[0].find((message) => message.role === "tool");
      if (tool && tool.content?.includes('"knowledge_layer":"wiki"')) {
        entered.resolve();
        await release.promise;
      }
      return regular(...args);
    });
    const input = request("ask");
    input.request_id = randomUUID();
    input.query = "查询混合检索";
    input.knowledge_scope = {
      private: true,
      public: false,
      team: false,
      document_ids: [doc.doc_id],
    };
    const pending = api
      .post("/ai/agent")
      .set(auth(bob))
      .send(input)
      .then((response) => response);
    await entered.promise;
    await api.delete(`/ai/wiki/${page.wiki_id}`).set(auth(bob)).expect(200);
    release.resolve();
    const events = frames((await pending).text);
    expect(events.some((event) => event.event === "result")).toBe(false);
    expect(events.at(-1)!.data.status).toBe("failed");
  });
});
