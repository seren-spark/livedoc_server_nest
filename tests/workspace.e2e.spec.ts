import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
  jest,
} from "@jest/globals";
import supertest from "supertest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { bootstrap } from "../src/main.js";
import { LlmService } from "../src/ai/llm.service.js";
import { AppConfig } from "../src/config/app-config.js";
import { request } from "./fixtures/agent-request.js";
describe("workspace and document agent API", () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let token: string;
  let other: string;
  let revision = 0;
  beforeAll(async () => {
    app = await bootstrap();
    await app.getHttpAdapter().getInstance().ready();
    api = supertest(app.getHttpServer());
    token = (
      await api
        .post("/dev/auth/login")
        .send({ email: "alice@livedoc.local", password: "Demo@123456" })
        .expect(200)
    ).body.token;
    other = (
      await api
        .post("/dev/auth/login")
        .send({ email: "bob@livedoc.local", password: "Demo@123456" })
        .expect(200)
    ).body.token;
    Object.defineProperty(app.get(AppConfig), "llmApiKey", {
      value: "test-model",
    });
  }, 30000);
  afterAll(async () => {
    await app.close();
  });
  const auth = () => ({ Authorization: `Bearer ${token}` });
  test('paged reads retain distinct evidence and final sources exclude unused pages', async () => {
    const seen: any[] = [];
    const actions = [
      { name: 'read_reference', args: { reference_id: 'notes', offset: 0, limit: 11 } },
      { name: 'read_reference', args: { reference_id: 'notes', offset: 12, limit: 12 } },
      { name: 'read_current_document', args: { region_ids: ['b0'] } },
      { name: 'read_current_document', args: { region_ids: ['b1'] } },
    ];
    const spy = jest.spyOn(app.get(LlmService), 'agentTurn').mockImplementation(async (messages, tools) => {
      if (!tools.length) return { message: { role: 'assistant', content: '{"strategy":"react","reason":"read"}' }, usage: {} };
      const outputs = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content!));
      const action = actions[outputs.length];
      if (!action) seen.push(...outputs);
      return { message: { role: 'assistant', content: null, tool_calls: [{
        id: `page-${outputs.length}`, type: 'function', function: {
          name: action?.name ?? 'finish_answer',
          arguments: JSON.stringify(action?.args ?? { answer: `first [${outputs[0].citation_id}]`, citation_ids: [outputs[0].citation_id] }),
        },
      }] }, usage: {} };
    });
    try {
      const input = request('ask');
      Object.assign(input, { request_id: 'paged-citations', query: '查看所选资料', references: [{ id: 'notes', kind: 'text', title: 'notes', content: 'first proof|second proof' }] });
      const response = await api.post('/ai/agent').set(auth()).send(input).expect(200);
      const events = response.text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
      const final = events.find((event) => event.result);
      expect(final).toBeDefined();
      expect(new Set(seen.map((item) => item.citation_id)).size).toBe(4);
      expect(final.citations).toHaveLength(1);
      expect(final.citations[0]).toMatchObject({ id: seen[0].citation_id, reference_id: 'notes', start_offset: 0, end_offset: 11, source_content: 'first proof' });
      const read = events.filter((event) => event.summary === '资料读取完成').at(-1).citations;
      expect(read).toHaveLength(4);
      expect(read.find((c: any) => c.id === seen[0].citation_id).source_content).toBe('first proof');
      expect(read.find((c: any) => c.id === seen[1].citation_id).source_content).toBe('second proof');
      expect(read.find((c: any) => c.id === seen[2].citation_id).source_content).toBe('first');
      expect(read.find((c: any) => c.id === seen[3].citation_id).source_content).toBe('second');
    } finally { spy.mockRestore(); }
  });
  test('web search has traceable citations and cannot execute with the web switch off', async () => {
    const config = app.get(AppConfig), llm = app.get(LlmService);
    const previousUrl = config.agentWebSearchUrl;
    Object.defineProperty(config, 'agentWebSearchUrl', { value: 'https://provider.example/search' });
    const search = jest.spyOn(llm, 'searchWeb').mockResolvedValue({ summary: 'Verified fact [1].', sources: [{ index: 1, title: 'Source', url: 'https://source.example/page' }] });
    let attempts = 0;
    let web = true;
    const turn = jest.spyOn(llm, 'agentTurn').mockImplementation(async (messages, tools) => {
      expect(tools.some(t => t.function.name === 'search_web')).toBe(web);
      const invocation = attempts++ === 0;
      const evidence = messages.find(m => m.role === 'tool' && m.content?.includes('"sources"'));
      const ids = evidence ? JSON.parse(evidence.content!).sources.map((s: any) => s.citation_id) : [];
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: `web-${attempts}`, type: 'function', function: {
        name: invocation ? 'search_web' : 'finish_answer',
        arguments: JSON.stringify(invocation ? { query: 'test query' } : { answer: 'answer', citation_ids: ids }),
      } }] }, usage: {} };
    });
    try {
      for (const enabled of [true, false]) {
        web = enabled; attempts = 0;
        const input = request('ask');
        Object.assign(input, { query: '查询资料', allow_web: enabled, request_id: `native-web-${enabled}` });
        const response = await api.post('/ai/agent').set({ Authorization: `Bearer ${other}` }).send(input).expect(200);
        expect(response.text).toContain('"kind":"answer"');
        if (enabled) {
          expect(response.text).toContain('https://source.example/page');
          const final = response.text.split('\n').filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6))).find((event) => event.result);
          expect(final.citations[0].evidence_kind).toBe('search_summary');
          expect(final.citations[0].source_content).toBeUndefined();
        }
        else expect(response.text).toContain('工具未加载或当前模式无权限');
      }
      expect(search).toHaveBeenCalledTimes(1);
    } finally { search.mockRestore(); turn.mockRestore(); Object.defineProperty(config, 'agentWebSearchUrl', { value: previousUrl }); }
  });
  test("Agent answers a general question without forcing document edits", async () => {
    const spy = jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages, tools) => {
        if (!tools.length)
          return {
            message: {
              role: "assistant",
              content: JSON.stringify({
                strategy: "react",
                reason: "普通问题",
              }),
            },
            usage: {},
          };
        expect(messages[0]!.content).toContain("输出目标只是写作时的保存位置");
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "weather-answer",
                type: "function",
                function: {
                  name: "finish_answer",
                  arguments: JSON.stringify({
                    answer: "查询天气需要所在城市和联网资料，目前未启用联网。",
                    citation_ids: [],
                  }),
                },
              },
            ],
          },
          usage: {},
        };
      });
    try {
      const input = request();
      input.query = "今天天气怎么样";
      input.request_id = "general-question";
      const response = await api
        .post("/ai/agent")
        .set(auth())
        .send(input)
        .expect(200);
      expect(response.text).toContain('"kind":"answer"');
      expect(response.text).toContain('"status":"completed"');
      expect(response.text).not.toContain("awaiting_review");
      expect(response.text).not.toContain('"kind":"edits"');
    } finally {
      spy.mockRestore();
    }
  });
  test("classification metadata does not overwrite a concurrent content save", async () => {
    const { DocumentsService } = await import(
      "../src/documents/documents.service.js"
    );
    const service = app.get(DocumentsService);
    const doc = (
      await api
        .post("/documents")
        .set(auth())
        .send({
          title: "concurrent",
          content: "old",
          source_type: "note",
          index_now: false,
        })
        .expect(201)
    ).body;
    let rev = (await api.get("/categories/tree").set(auth())).body.revision;
    const category = (
      await api
        .post("/categories")
        .set(auth())
        .send({ name: "Concurrent", expected_tree_revision: rev })
        .expect(201)
    ).body;
    rev = category.revision;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const original = service.ownedPrivate.bind(service);
    const spy = jest
      .spyOn(service, "ownedPrivate")
      .mockImplementation(async (c, m) => {
        const rows = await original(c, m);
        if (first) {
          first = false;
          const copy = structuredClone(rows);
          enter();
          await gate;
          return copy;
        }
        return rows;
      });
    try {
      const pending = api
        .post("/categories/assign")
        .set(auth())
        .send({
          ids: [doc.doc_id],
          category_id: category.result.category_id,
          expected_tree_revision: rev,
        })
        .then((r) => r);
      await entered;
      await api
        .patch(`/documents/${doc.doc_id}`)
        .set(auth())
        .send({ content: "new content", expected_version: 1 })
        .expect(200);
      release();
      expect((await pending).status).toBe(201);
      const updated = (
        await api.get(`/documents/${doc.doc_id}`).set(auth()).expect(200)
      ).body;
      expect(updated.content).toBe("new content");
      expect(updated.document_version).toBe(2);
      revision = (await api.get("/categories/tree").set(auth())).body.revision;
    } finally {
      release();
      spy.mockRestore();
    }
  });
  test("confirmed import cannot bypass trash, and purge removes its source and job snapshots", async () => {
    const { DoclingParserService } = await import(
      "../src/document-imports/docling-parser.service.js"
    );
    const { ImportWorkerService } = await import(
      "../src/document-imports/import-worker.service.js"
    );
    const { DocumentImportsService } = await import(
      "../src/document-imports/document-imports.service.js"
    );
    const { IndexJobsService } = await import(
      "../src/indexing/index-jobs.service.js"
    );
    jest.spyOn(app.get(DoclingParserService), "parse").mockResolvedValueOnce({
      title: "source",
      markdown: "private source",
      parser_version: "test",
      images: [],
    });
    const uploaded = (
      await api
        .post("/document-imports")
        .set(auth())
        .attach("file", Buffer.from("%PDF-1.4\nfake"), {
          filename: "source.pdf",
          contentType: "application/pdf",
        })
        .field("visibility", "private")
        .expect(202)
    ).body;
    await app.get(ImportWorkerService).runOnce("import-test");
    const confirmed = (
      await api
        .post(`/document-imports/${uploaded.import_id}/confirm`)
        .set(auth())
        .expect(202)
    ).body;
    const id = confirmed.document.doc_id;
    await api.delete(`/documents/${id}`).set(auth()).expect(200);
    await api
      .get(`/document-imports/${uploaded.import_id}`)
      .set(auth())
      .expect(404);
    const trash = (await api.get("/trash?type=document").set(auth())).body;
    await api
      .post("/trash/purge")
      .set(auth())
      .send({
        type: "document",
        ids: [id],
        expected_tree_revision: trash.revision,
      })
      .expect(201);
    expect(
      await app.get(DocumentImportsService).get(uploaded.import_id),
    ).toBeNull();
    expect(
      await app.get(IndexJobsService).get(confirmed.index_job.job_id),
    ).toBeNull();
    revision = (await api.get("/categories/tree").set(auth())).body.revision;
  });
  const category = async (name: string, parent_id: string | null = null) => {
    const response = await api
      .post("/categories")
      .set(auth())
      .send({ name, parent_id, expected_tree_revision: revision })
      .expect(201);
    revision = response.body.revision;
    return response.body.result.category_id as string;
  };
  test("depth, exact filtering, deletion batches and ancestor restoration", async () => {
    const a = await category("A");
    const b = await category("B", a);
    const c = await category("C", b);
    await api
      .post("/categories")
      .set(auth())
      .send({ name: "D", parent_id: c, expected_tree_revision: revision })
      .expect(400);
    await api
      .post(`/categories/${a}/move`)
      .set(auth())
      .send({ parent_id: c, expected_tree_revision: revision })
      .expect(400);
    const docs = [];
    for (const title of ["first", "second"])
      docs.push(
        (
          await api
            .post("/documents")
            .set(auth())
            .send({
              title,
              content: "same contents",
              source_type: "note",
              index_now: false,
            })
            .expect(201)
        ).body,
      );
    let response = await api
      .post("/categories/assign")
      .set(auth())
      .send({
        ids: [docs[0].doc_id],
        category_id: b,
        expected_tree_revision: revision,
      })
      .expect(201);
    revision = response.body.revision;
    response = await api
      .post("/categories/assign")
      .set(auth())
      .send({
        ids: [docs[1].doc_id],
        category_id: c,
        expected_tree_revision: revision,
      })
      .expect(201);
    revision = response.body.revision;
    const direct = await api
      .get(`/documents?category_id=${b}`)
      .set(auth())
      .expect(200);
    expect(direct.body.items.map((d: any) => d.doc_id)).toEqual([
      docs[0].doc_id,
    ]);
    await api.delete(`/documents/${docs[0].doc_id}`).set(auth()).expect(200);
    revision = (await api.get("/categories/tree").set(auth())).body.revision;
    response = await api
      .post(`/categories/${a}/trash`)
      .set(auth())
      .send({ include_documents: true, expected_tree_revision: revision })
      .expect(201);
    revision = response.body.revision;
    await api.get(`/documents/${docs[1].doc_id}`).set(auth()).expect(404);
    await api
      .post("/trash/restore")
      .set(auth())
      .send({
        type: "category",
        ids: [c],
        include_documents: true,
        expected_tree_revision: revision,
      })
      .expect(201);
    revision = (await api.get("/categories/tree").set(auth())).body.revision;
    const tree = await api.get("/categories/tree").set(auth());
    expect(tree.body.items.map((n: any) => n.category_id)).toEqual(
      expect.arrayContaining([a, b, c]),
    );
    await api.get(`/documents/${docs[1].doc_id}`).set(auth()).expect(200);
    await api.get(`/documents/${docs[0].doc_id}`).set(auth()).expect(404);
    await api
      .get(`/documents/${docs[1].doc_id}`)
      .set({ Authorization: `Bearer ${other}` })
      .expect(403);
    await api
      .post("/categories")
      .set(auth())
      .send({ name: "stale", expected_tree_revision: 0 })
      .expect(409);
  });
  test("merge moves documents and restores an empty source; templates are owner scoped", async () => {
    const source = await category("Source");
    const target = await category("Target");
    await category("same", source);
    await category("same", target);
    let response = await api
      .post(`/categories/${source}/merge`)
      .set(auth())
      .send({ target_id: target, expected_tree_revision: revision })
      .expect(201);
    revision = response.body.revision;
    const tree = await api.get("/categories/tree").set(auth());
    expect(tree.body.items.filter((c: any) => c.name === "same")).toHaveLength(
      1,
    );
    const created = await api
      .post("/note-templates")
      .set(auth())
      .send({
        name: "my template",
        markdown: "# hello",
        description: "x",
        instructions: "y",
      })
      .expect(201);
    await api
      .get(`/note-templates/${created.body.template_id}`)
      .set({ Authorization: `Bearer ${other}` })
      .expect(404);
    await api
      .patch(`/note-templates/${created.body.template_id}`)
      .set(auth())
      .send({ name: "new", expected_revision: 99 })
      .expect(409);
    await api.delete("/note-templates/builtin-meeting").set(auth()).expect(403);
  });
  test("Agent emits reviewed candidates without changing persisted body; audit and mode gates work", async () => {
    const llm = app.get(LlmService);
    const spy = jest
      .spyOn(llm, "agentTurn")
      .mockImplementation(async (messages) => ({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: messages.some((m) => m.role === "tool") ? "call-1" : "read-1",
              type: "function",
              function: {
                name: messages.some((m) => m.role === "tool")
                  ? "propose_document_edits"
                  : "read_current_document",
                arguments: JSON.stringify(
                  messages.some((m) => m.role === "tool")
                    ? {
                        edits: [
                          {
                            id: "e",
                            operation: "replace",
                            target: {
                              kind: "block_range",
                              first_region_id: "b0",
                            },
                            content_markdown: "new first",
                            explanation: "replace",
                            citation_ids: [],
                          },
                        ],
                      }
                    : { region_ids: [] },
                ),
              },
            },
          ],
        },
        usage: {},
      }));
    const input = request();
    input.request_id = "api-agent";
    const result = await api
      .post("/ai/agent")
      .set(auth())
      .send(input)
      .expect(200);
    expect(result.text).toContain("awaiting_review");
    expect(result.text).toContain("new first");
    const frames = result.text
      .split("\n\n")
      .filter((f) => f.includes("data:"))
      .map((f) => JSON.parse(f.split("data: ")[1]!));
    const runId = frames[0].run_id;
    expect(
      (await api.get(`/ai/tool-audits?run_id=${runId}`).set(auth())).body,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ call_id: "call-1", status: "success" }),
      ]),
    );
    await api
      .get(`/ai/agent/${runId}`)
      .set({ Authorization: `Bearer ${other}` })
      .expect(404);
    await api
      .post(`/ai/agent/${runId}/feedback`)
      .set(auth())
      .send({ action: "accepted", edit_id: "unknown" })
      .expect(400);
    await api
      .post(`/ai/agent/${runId}/feedback`)
      .set(auth())
      .send({ action: "accepted", edit_id: "e" })
      .expect(201);
    input.mode = "ask";
    input.request_id = "api-ask-invalid";
    const ask = await api.post("/ai/agent").set(auth()).send(input).expect(200);
    expect(ask.text).not.toContain('"kind":"edits"');
    expect(ask.text).toContain("failed");
    spy.mockRestore();
  });
  test("Plan stops at a plan, while a confirmed plan reads before generating and runs reflection", async () => {
    let currentCitationId = '';
    const plan = {
      goal: "完善文稿",
      outline: ["正文"],
      constraints: [],
      steps: [
        {
          id: "read",
          description: "读取全文",
          depends_on: [],
          capability: "read" as const,
        },
      ],
    };
    const call = (name: string, args: any) => ({
      message: {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: `c-${Math.random()}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      usage: {},
    });
    const spy = jest
      .spyOn(app.get(LlmService), "agentTurn")
      .mockImplementation(async (messages, tools, _signal, options) => {
        const context = JSON.parse(
          messages.find((m) => m.role === "user")?.content ?? "{}",
        );
        if (options?.role === "critic")
          return {
            message: {
              role: "assistant",
              content: JSON.stringify({
                passed: false,
                issues: [{ type: "style", description: "表达应简洁" }],
              }),
            },
            usage: {},
          };
        if (options?.json)
          return {
            message: {
              role: "assistant",
              content: JSON.stringify({
                ...context.candidate,
                markdown: "# 修正文稿\n\n依据资料编写。",
              }),
            },
            usage: {},
          };
        if (tools.some((t) => t.function.name === "submit_plan"))
          return call("submit_plan", { plan });
        if (context.step && !messages.some((m) => m.role === "tool"))
          return call("read_current_document", { region_ids: [] });
        if (context.step) {
          currentCitationId = JSON.parse(messages.find((m) => m.role === 'tool')!.content!).citation_id;
          return call("finish_answer", {
            answer: "读取了两个段落",
            citation_ids: [currentCitationId],
          });
        }
        return call("propose_new_document", {
          title: "文稿",
          markdown: "# 初稿\n\n较长的初稿。",
          citation_ids: [currentCitationId],
        });
      });
    const input = request("plan");
    input.request_id = "plan-only";
    input.output_target = "new_document";
    const planned = await api
      .post("/ai/agent")
      .set({ Authorization: `Bearer ${other}` })
      .send(input)
      .expect(200);
    expect(planned.text).toContain('"kind":"plan"');
    expect(planned.text).not.toContain("awaiting_review");
    expect(spy).toHaveBeenCalledTimes(1);
    input.mode = "agent";
    input.request_id = "confirmed-plan";
    input.confirmed_plan = plan;
    const executed = await api
      .post("/ai/agent")
      .set({ Authorization: `Bearer ${other}` })
      .send(input)
      .expect(200);
    expect(executed.text).toContain("confirmed_plan");
    expect(executed.text).toContain("修正文稿");
    expect(executed.text).toContain("awaiting_review");
    expect(executed.text).toContain('"status":"revised"');
    spy.mockRestore();
  });
  test("duplicate request IDs do not execute again, and deletion keeps stale vector hits out", async () => {
    const spy = jest.spyOn(app.get(LlmService), "agentTurn").mockResolvedValue({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "answer",
            type: "function",
            function: {
              name: "finish_answer",
              arguments: JSON.stringify({ answer: "ok", citation_ids: [] }),
            },
          },
        ],
      },
      usage: {},
    });
    const input = request("ask");
    input.query = "查询内容";
    input.request_id = "duplicate";
    await api.post("/ai/agent").set(auth()).send(input).expect(200);
    await api.post("/ai/agent").set(auth()).send(input).expect(409);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const doc = (
      await api
        .post("/documents")
        .set(auth())
        .send({
          title: "deleted vector",
          content: "secret",
          source_type: "note",
          index_now: false,
        })
        .expect(201)
    ).body;
    const { DocumentsService } = await import(
      "../src/documents/documents.service.js"
    );
    const { DocumentCatalog } = await import(
      "../src/database/document-catalog.js"
    );
    await app.get(DocumentsService).markReady(doc.doc_id, 1, 1);
    const hits = [
      {
        pointId: "x",
        score: 1,
        payload: { doc_id: doc.doc_id, document_version: 1 },
      },
    ];
    const context = { user_id: "alice", space_id: "space_demo", team_ids: [] };
    const row = await app.get(DocumentsService).get(doc.doc_id);
    context.user_id = row!.owner_id!;
    context.space_id = row!.space_id;
    expect(
      await app.get(DocumentCatalog).readableHits(hits, context),
    ).toHaveLength(1);
    await api.delete(`/documents/${doc.doc_id}`).set(auth()).expect(200);
    expect(
      await app.get(DocumentCatalog).readableHits(hits, context),
    ).toHaveLength(0);
    await api
      .patch(`/documents/${doc.doc_id}`)
      .set(auth())
      .send({ content: "overwrite", expected_version: 1 })
      .expect(404);
  });
});
