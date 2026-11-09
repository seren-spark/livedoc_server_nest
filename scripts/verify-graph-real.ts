import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
import mysql from "mysql2/promise";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DocumentRecord } from "../src/documents/document.types.js";

const env = parse(readFileSync(new URL("../.env", import.meta.url)));
const baseUrl = process.env.GRAPH_TEST_DATABASE_URL ?? env.DATABASE_URL!;
const database = "livedoc_langgraph_real_test";
const url = new URL(baseUrl);
url.pathname = "/" + database;
mkdirSync(".tmp", { recursive: true });
const stateFile = ".tmp/graph-real-state.json";
const phase = process.argv[2];
if (!phase) {
  const connection = await mysql.createConnection(baseUrl);
  await connection.query(
    "CREATE DATABASE IF NOT EXISTS livedoc_langgraph_real_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
  );
  await connection.end();
  for (const step of ["create", "resume"])
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--loader", "ts-node/esm", "scripts/verify-graph-real.ts", step],
        { stdio: "inherit", windowsHide: true },
      );
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Real-model ${step} failed`)),
      );
      child.on("error", reject);
    });
  process.exit(0);
}

for (const [name, value] of Object.entries(env))
  if (
    /^LLM_|^AGENT_(?:CLASSIFIER|PLAN|CRITIC|THINKING|MAX_|FINALIZATION|TIMEOUT)/.test(
      name,
    )
  )
    process.env[name] = value;
Object.assign(process.env, {
  NODE_ENV: "test",
  RAG_RUNTIME_MODE: "test",
  DATABASE_URL: url.toString(),
  METADATA_STORE: "mysql",
  MEMORY_STORE: "mysql",
  VECTOR_STORE: "memory",
  EMBEDDING_PROVIDER: "hash",
  RERANK_PROVIDER: "lexical",
  AGENT_TOOL_SELECTION: "llm",
  AGENT_GRAPH_ENABLED: "true",
  LIVEDOC_RUN_MIGRATIONS: "true",
});
const { Logger } = await import("@nestjs/common");
Logger.overrideLogger(["error", "warn"]);
const { bootstrap } = await import("../src/main.js");
const { AgentGraphService } = await import(
  "../src/ai/graph/agent-graph.service.js"
);
const { DocumentsService } = await import(
  "../src/documents/documents.service.js"
);
const { IndexJobsService } = await import(
  "../src/indexing/index-jobs.service.js"
);
const { IndexWorkerService } = await import(
  "../src/indexing/index-worker.service.js"
);
const { RetrievalService } = await import(
  "../src/retrieval/retrieval.service.js"
);
const { toIndexRequest } = await import("../src/documents/document.types.js");
const { request } = await import("../tests/fixtures/agent-request.js");
const app = await bootstrap();
const service = app.get(AgentGraphService),
  repo = service.repository;
const context = {
  user_id: "user_alice",
  space_id: "space_a",
  team_ids: ["team_alpha"],
};
const waitFor = async (id: string, statuses: string[]) => {
  const end = Date.now() + 280000;
  while (Date.now() < end) {
    const run = await repo.get(id, context);
    if (statuses.includes(run.status)) return run;
    if (["failed", "stopped", "interrupted"].includes(run.status))
      throw new Error(
        `${run.status}: ${run.payload.error ?? "task interrupted"}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Real-model task timed out");
};
try {
  if (phase === "create") {
    const input = {
      ...request("plan"),
      request_id: randomUUID(),
      conversation_id: randomUUID(),
      query:
        "先给我一个简短计划，确认后把当前选区改写得更自然。保持含义，不引入新事实，只需一个阅读步骤。",
    };
    const text = "本项目提供文档的编辑能力，也可以使用知识库检索。";
    input.editor_snapshot.selection.text = text;
    input.editor_snapshot.regions[0]!.text = text;
    input.editor_snapshot.regions[0]!.markdown = text;
    (input.editor_snapshot.json.content as any[])[0].content[0].text = text;
    const created = await service.create(input, context);
    const waiting = await waitFor(created.run_id, ["waiting_input"]);
    assert.equal(waiting.control.waiting.value.type, "plan");
    writeFileSync(
      stateFile,
      JSON.stringify({
        run_id: waiting.run_id,
        requests_before_restart: waiting.budget.model_requests,
      }),
    );
    console.log(
      JSON.stringify({
        phase,
        status: waiting.status,
        model_requests: waiting.budget.model_requests,
      }),
    );
  } else {
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    const waiting = await repo.get(saved.run_id, context);
    assert.equal(waiting.budget.model_requests, saved.requests_before_restart);
    await service.command(
      saved.run_id,
      context,
      {
        request_id: randomUUID(),
        expected_revision: waiting.revision,
        action: "approve_plan",
        interrupt_id: waiting.control.waiting.id,
        plan: waiting.control.waiting.value.plan,
      },
      "resume",
    );
    const done = await waitFor(saved.run_id, ["awaiting_review"]);
    assert.equal(done.payload.delivery.result.kind, "edits");
    console.log(
      JSON.stringify({
        phase,
        status: done.status,
        original_mode: done.mode,
        model_requests: done.budget.model_requests,
      }),
    );

    const documents = app.get(DocumentsService),
      jobs = app.get(IndexJobsService),
      worker = app.get(IndexWorkerService);
    const docs: DocumentRecord[] = [];
    for (const [title, content] of [
      [
        "固定分块方案",
        "固定分块按固定字符数切分，容易实现，适合结构简单的纯文本。可能切断上下文。本文没有吞吐量和准确率的性能实验数据。",
      ],
      [
        "按标题分块方案",
        "按标题分块保留章节结构，适合层次清晰的技术文档。章节过长时需要继续拆分。本文没有吞吐量和准确率的性能实验数据。",
      ],
    ]) {
      const doc = await documents.create(
        {
          title: title!,
          content: content!,
          visibility: "private",
          source_type: "note",
          tags: [],
          index_now: false,
          asset_ids: [],
        },
        context,
      );
      const job = await jobs.enqueue(toIndexRequest(doc), context);
      await documents.markQueued(doc.doc_id, job.job_id);
      await worker.runOnce("graph-real-verification", job.job_id);
      assert.equal((await jobs.get(job.job_id))?.status, "succeeded");
      docs.push(doc);
    }
    // Fault injection: expose only one real indexed source on the first lookup, then let the real retriever return both.
    const retriever = app.get(RetrievalService),
      originalSearch = retriever.searchWithTrace.bind(retriever);
    let lookups = 0;
    retriever.searchWithTrace = async (...args) => {
      const result = await originalSearch(...args);
      if (++lookups === 1)
        return {
          ...result,
          citations: result.citations.filter(
            (c) => c.doc_id === docs[0]!.doc_id,
          ),
        };
      return result;
    };
    const ragInput = {
      ...request("ask"),
      request_id: randomUUID(),
      conversation_id: randomUUID(),
      query:
        "比较固定分块与按标题分块的适用场景和局限。若第一次资料缺少另一方案，请再补充检索一次；没有性能实验数据就明确说明。",
      knowledge_scope: {
        private: true,
        public: false,
        team: false,
        document_ids: docs.map((doc) => doc.doc_id),
      },
    };
    const rag = await service.create(ragInput, context);
    const answered = await waitFor(rag.run_id, ["completed"]);
    assert.equal(answered.payload.delivery.result.kind, "answer");
    assert.ok(answered.payload.delivery.citations.length > 0);
    assert.ok(
      lookups >= 2,
      "The controlled evidence gap must trigger another retrieval",
    );
    assert.equal(answered.payload.supervisor.supplement_count, 1);
    console.log(
      JSON.stringify({
        phase: "adaptive-retrieval",
        status: answered.status,
        lookups,
        supplement_count: answered.payload.supervisor.supplement_count,
        citations: answered.payload.delivery.citations.length,
        model_requests: answered.budget.model_requests,
      }),
    );
    writeFileSync(
      ".tmp/graph-real-results.json",
      JSON.stringify(
        {
          plan: {
            run_id: done.run_id,
            status: done.status,
            usage: done.budget,
          },
          retrieval: {
            run_id: answered.run_id,
            status: answered.status,
            lookups,
            supplements: answered.payload.supervisor.supplement_count,
            usage: answered.budget,
          },
        },
        null,
        2,
      ),
    );
  }
} finally {
  await app.close();
}
