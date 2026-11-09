import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { ForbiddenException, Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import supertest from "supertest";
import { bootstrap } from "../src/main.js";
import { AppConfig } from "../src/config/app-config.js";
import { LlmService } from "../src/ai/llm.service.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { AgentAuditService } from "../src/ai/agent-audit.service.js";
import { request } from "./fixtures/agent-request.js";

const call = (name: string, args: unknown) => ({
  message: { role: "assistant" as const, content: null, tool_calls: [{ id: "call", type: "function" as const,
    function: { name, arguments: JSON.stringify(args) } }] },
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});
const frames = (text: string) => text.split("\n\n").filter(frame => frame.includes("data: "))
  .map(frame => ({ event: frame.match(/^event: (.+)$/m)![1], data: JSON.parse(frame.split("data: ")[1]!) }));

describe("completed agent result recovery", () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let alice: string;
  let bob: string;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    app = await bootstrap();
    await app.getHttpAdapter().getInstance().ready();
    api = supertest(app.getHttpServer());
    const login = async (email: string) => (await api.post("/dev/auth/login")
      .send({ email, password: "Demo@123456" }).expect(200)).body.token;
    alice = await login("alice@livedoc.local");
    bob = await login("bob@livedoc.local");
    Object.defineProperty(app.get(AppConfig), "llmApiKey", { value: "controlled" });
  }, 30000);
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => { await app.close(); Logger.overrideLogger(["log", "error", "warn", "debug", "verbose", "fatal"]); });

  test("restores a pending edit only against the same document snapshot, and cannot cross owners", async () => {
    jest.spyOn(app.get(LlmService), "agentTurn").mockImplementation(async messages => {
      if (!messages.some(message => message.role === "tool")) return call("read_current_document", { region_ids: ["b0"] });
      return call("propose_document_edits", { edits: [{ id: "edit", operation: "replace",
        target: { kind: "block_range", first_region_id: "b0" }, content_markdown: "updated first",
        explanation: "rewrite", citation_ids: [] }] });
    });
    const input = request();
    input.request_id = "recover-edits";
    const response = await api.post("/ai/agent").set("Authorization", `Bearer ${alice}`).send(input).expect(200);
    const events = frames(response.text);
    const published = events.find(frame => frame.event === "result")!;
    expect(published).toBeDefined();
    const id = published.data.run_id;
    const recovered = await api.post(`/ai/agent/${id}/restore`).set("Authorization", `Bearer ${alice}`)
      .send({ editor_json: input.editor_snapshot.json }).expect(201);
    expect(recovered.body.status).toBe("awaiting_review");
    expect(recovered.body.payload.delivery.result).toEqual(published.data.result);
    expect(recovered.body.payload.traces.some((span: any) => span.kind === "model" && span.status === "success")).toBe(true);
    expect(recovered.body.payload.traces.filter((span: any) => span.kind === "tool").every((span: any) => span.status !== "running")).toBe(true);
    await api.post(`/ai/agent/${id}/restore`).set("Authorization", `Bearer ${bob}`)
      .send({ editor_json: input.editor_snapshot.json }).expect(404);
    await api.post(`/ai/agent/${id}/restore`).set("Authorization", `Bearer ${alice}`)
      .send({ editor_json: { type: "doc", content: [] } }).expect(409);
    await api.post(`/ai/agent/${id}/feedback`).set("Authorization", `Bearer ${alice}`)
      .send({ action: "accepted", edit_id: "edit" }).expect(201);
    const handled = await api.post(`/ai/agent/${id}/restore`).set("Authorization", `Bearer ${alice}`)
      .send({ editor_json: { type: "doc", content: [] } }).expect(201);
    expect(handled.body.status).toBe("completed");
    expect(handled.body.payload.feedback.edit).toBe("accepted");
  });

  test("recovers untouched remaining edits after partial adoption and a saved document version change", async () => {
    let version = 1;
    jest.spyOn(app.get(DocumentsService), "getAccessible").mockImplementation(async () =>
      ({ doc_id: "target", document_version: version }) as any);
    jest.spyOn(app.get(LlmService), "agentTurn").mockImplementation(async (messages, _tools, _signal, options) => {
      if (options?.role === "critic") return { message: { role: "assistant", content: '{"passed":true,"issues":[]}' }, usage: {} };
      if (!messages.some(message => message.role === "tool")) return call("read_current_document", { region_ids: ["b0", "b1"] });
      return call("propose_document_edits", { edits: [
        { id: "first", operation: "replace", target: { kind: "block_range", first_region_id: "b0" },
          content_markdown: "changed\n\nadded", explanation: "rewrite", citation_ids: [] },
        { id: "second", operation: "replace", target: { kind: "block_range", first_region_id: "b1" },
          content_markdown: "updated second", explanation: "rewrite", citation_ids: [] },
      ] });
    });
    const input = request();
    input.request_id = "recover-partial";
    input.editor_snapshot.identity = { kind: "knowledge", doc_id: "target", persisted_version: 1 };
    const response = await api.post("/ai/agent").set("Authorization", `Bearer ${alice}`).send(input).expect(200);
    const published = frames(response.text).find(frame => frame.event === "result")!;
    expect(published).toBeDefined();
    const id = published.data.run_id;
    await api.post(`/ai/agent/${id}/feedback`).set("Authorization", `Bearer ${alice}`)
      .send({ action: "accepted", edit_id: "first" }).expect(201);
    version = 2;
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const json = { type: "doc", content: [paragraph("changed"), paragraph("added"), paragraph("second")] };
    const restored = await api.post(`/ai/agent/${id}/restore`).set("Authorization", `Bearer ${alice}`)
      .send({ editor_json: json }).expect(201);
    expect(restored.body.payload.delivery.result.edits[1].target).toMatchObject({ first_region_id: "b2", last_region_id: "b2" });
    expect(restored.body.payload.feedback.first).toBe("accepted");
    expect(app.get(AgentAuditService).runs.get(id)!.payload.delivery.result.edits[1].target.first_region_id).toBe("b1");
    for (const content of [[paragraph("changed"), paragraph("manual second")], [...json.content, paragraph("second")]])
      await api.post(`/ai/agent/${id}/restore`).set("Authorization", `Bearer ${alice}`)
        .send({ editor_json: { type: "doc", content } }).expect(409);
  });

  test.each(["revoked", "version"])("does not release stored source content after %s", async change => {
    let changed = false;
    jest.spyOn(app.get(DocumentsService), "getAccessible").mockImplementation(async () => {
      if (changed && change === "revoked") throw new ForbiddenException("revoked");
      return { doc_id: "source", title: "source", content: "trusted evidence", document_version: changed ? 2 : 1 } as any;
    });
    jest.spyOn(app.get(LlmService), "agentTurn").mockImplementation(async messages => {
      const tool = messages.find(message => message.role === "tool");
      if (!tool) return call("read_reference", { reference_id: "note" });
      return call("finish_answer", { answer: "trusted evidence", citation_ids: [JSON.parse(tool.content!).citation_id] });
    });
    const input = request("ask");
    input.request_id = `recover-${change}`;
    input.references = [{ id: "note", kind: "document", doc_id: "source", title: "source" }];
    const response = await api.post("/ai/agent").set("Authorization", `Bearer ${alice}`).send(input).expect(200);
    const published = frames(response.text).find(frame => frame.event === "result")!;
    expect(published).toBeDefined();
    changed = true;
    const denied = await api.post(`/ai/agent/${published.data.run_id}/restore`).set("Authorization", `Bearer ${alice}`)
      .send({ editor_json: input.editor_snapshot.json })
      .expect(change === "revoked" ? 403 : 409);
    expect(JSON.stringify(denied.body)).not.toContain("trusted evidence");
    const audit = await api.get(`/ai/agent/${published.data.run_id}`).set("Authorization", `Bearer ${alice}`).expect(200);
    expect(audit.body.payload.delivery).toBeUndefined();
    expect(JSON.stringify(audit.body)).not.toContain("trusted evidence");
  });

  test("unfinished records from another process are reported as interrupted without restarting work", async () => {
    const audit = app.get(AgentAuditService);
    const record = [...audit.runs.values()][0]!;
    audit.runs.set("orphaned", { ...record, run_id: "orphaned", status: "executing", payload: {} });
    const llm = jest.spyOn(app.get(LlmService), "agentTurn");
    const response = await api.get("/ai/agent/orphaned").set("Authorization", `Bearer ${alice}`).expect(200);
    expect(response.body.status).toBe("interrupted");
    expect(llm).not.toHaveBeenCalled();
  });
});
