// Real models + isolated in-memory retrieval. Only the bundled synthetic corpus is sent upstream.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Logger } from "@nestjs/common";
import { AppConfig } from "../src/config/app-config.js";
import { DocumentAgentService } from "../src/ai/document-agent.service.js";
import { AgentAuditService } from "../src/ai/agent-audit.service.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { toIndexRequest } from "../src/documents/document.types.js";
import { RetrievalService } from "../src/retrieval/retrieval.service.js";
import { WikiService } from "../src/wiki/wiki.service.js";
import type { DocumentAgentDto } from "../src/ai/document-agent.dto.js";
import type { AgentEvent, AgentResult } from "../src/ai/document-agent.types.js";
import { checkAgentAnswer, parseAgentCases } from "./agent-evaluation-checks.js";

const cases = parseAgentCases(JSON.parse(await readFile(new URL("../evals/agent-cases.json", import.meta.url), "utf8")));
if (process.argv.includes("--validate-only")) {
  console.log(JSON.stringify({ cases: cases.length, valid: true }));
} else {
  // Override every persistent store before constructing the app; never connect to the configured MySQL/Qdrant.
  Object.assign(process.env, {
    LIVEDOC_SKIP_AUTO_START: "true", RAG_RUNTIME_MODE: "test", APP_ENV: "development",
    METADATA_STORE: "memory", MEMORY_STORE: "memory", INDEX_JOB_STORE: "memory",
    IMPORT_JOB_STORE: "memory", OBSERVABILITY_STORE: "memory", VECTOR_STORE: "memory",
    EMBEDDING_PROVIDER: "hash", SPARSE_EMBEDDING_PROVIDER: "memory_bm25", RERANK_PROVIDER: "heuristic",
    MCP_ENABLED: "false", DOCUMENT_MEMORY_ENABLED: "false", QUERY_EXPANSION_ENABLED: "false",
  });
  const { bootstrap } = await import("../src/main.js");
  Logger.overrideLogger(false);
  const app = await bootstrap();
  const config = app.get(AppConfig);
  assert.equal(config.metadataStore, "memory");
  assert.equal(config.vectorStore, "memory");
  // Exclude background compilation from both arms so one arm cannot change the other's knowledge.
  app.get(WikiService).enqueueCapture = () => {};
  const rows: Array<Record<string, any>> = [];
  const reportPath = resolve(config.projectRoot, "../docs/agent-evaluation.json");
  try {
    assert(config.llmApiKey, "请先配置真实模型");
    for (const item of cases) {
      const context = { user_id: `agent-eval-${randomUUID()}`, space_id: "synthetic-agent-eval", team_ids: [] };
      const ids: string[] = [];
      for (const source of item.sources) {
        const doc = await app.get(DocumentsService).create({ ...source, tags: [], visibility: "private", source_type: "note" } as any, context);
        const chunks = await app.get(RetrievalService).indexDocument(toIndexRequest(doc));
        await app.get(DocumentsService).markReady(doc.doc_id, chunks, doc.document_version);
        ids.push(doc.doc_id);
      }
      for (const arm of ["single", "multi"] as const) {
        const json = { type: "doc", content: [{ type: "paragraph" }] };
        const input: DocumentAgentDto = {
          request_id: randomUUID(), conversation_id: randomUUID(), mode: "ask", output_target: "current_document",
          query: `${item.query}\n每个事实单独一行，在同行使用原文 citation_id 引用。`, deep_thinking: false, allow_web: false, references: [],
          knowledge_scope: { private: true, public: false, team: false, document_ids: ids },
          editor_snapshot: {
            identity: { kind: "unsaved", local_id: item.id }, title: "合成评测", json, revision: 0, hash: item.id,
            selection: { text: "", inline: true, region_ids: ["b0"] },
            regions: [{ id: "b0", type: "paragraph", heading_path: [], text: "", markdown: "", original_json: json.content[0]! }],
          },
          ...(arm === "multi" ? { confirmed_plan: { goal: item.query, outline: [], constraints: ["仅依据授权合成资料，标明冲突或缺失"],
            steps: [ ...item.sources.map((source, index) => ({ id: `s${index}`, description: `检索知识库中的《${source.title}》，提取与问题相关的原始证据并引用。`,
              capability: "search" as const, depends_on: [] as string[] })),
              ...(item.compose_step ? [{ id: "combine", description: "结合依赖资料整理清单，完整保留限制、缺口和证据绑定。",
                capability: "compose" as const, depends_on: item.sources.map((_, index) => `s${index}`) }] : []),
            ] } } : {}),
        };
        const events: AgentEvent[] = [];
        const start = performance.now();
        for await (const event of app.get(DocumentAgentService).run(input, context, AbortSignal.timeout(300000))) events.push(event);
        const delivery = events.find(event => event.event === "result")?.data;
        const result = delivery?.result as AgentResult | undefined;
        const done = events.find(event => event.event === "done")?.data;
        const runId = events[0]?.data.run_id;
        const run = runId ? await app.get(AgentAuditService).get(runId, context) : undefined;
        const strategy = events.find(event => event.event === "route")?.data.strategy;
        const answer = result?.kind === "answer" ? result.answer : "";
        const quality = checkAgentAnswer(item, result, delivery?.citations ?? [], ids);
        const checks = [...quality.checks,
          { name: "completed", passed: done?.status === "completed" },
          { name: "strategy", passed: strategy === (arm === "single" ? "react" : "plan_execute") }];
        const passed = checks.every(check => check.passed);
        rows.push({ case_id: item.id, arm, strategy, passed: Boolean(passed), checks,
          result_kind: result?.kind, status: done?.status,
          clarification: result?.kind === "clarification" ? result.question : undefined,
          citation_count: result?.kind === "answer" ? result.citation_ids.length : 0,
          duration_ms: Math.round(performance.now() - start), usage: done?.usage ?? run?.payload.usage,
          failure: run?.payload.failure, error: run?.payload.error, traces: run?.payload.traces, answer });
        console.log(JSON.stringify({ case_id: item.id, arm, passed: Boolean(passed), duration_ms: rows.at(-1)!.duration_ms }));
      }
    }
  } finally {
    await app.close();
    const summary = Object.fromEntries(["single", "multi"].map(arm => {
      const results = rows.filter(row => row.arm === arm);
      const durations = results.map(row => row.duration_ms).sort((a, b) => a - b);
      return [arm, { cases: results.length, passed: results.filter(row => row.passed).length,
        p95_ms: durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)],
        tokens: results.reduce((total, row) => total + (row.usage?.prompt_tokens ?? 0) + (row.usage?.completion_tokens ?? 0), 0) }];
    }));
    await writeFile(reportPath, JSON.stringify({ checked_at: new Date().toISOString(), model: config.llmModel,
      real_models: true, models: { classifier: config.agentClassifierModel, plan: config.agentPlanModel, critic: config.agentCriticModel },
      retrieval_backend: "in_memory_hash", synthetic_only: true, background_capture: false,
      evaluation: "required facts bound to inline adopted original sources, scope, missing/conflict and forbidden-claim checks; not a semantic entailment judge", summary, rows }, null, 2));
    console.log(JSON.stringify({ report: reportPath, summary }));
    if (rows.length !== cases.length * 2 || rows.some(row => !row.passed)) process.exitCode = 1;
  }
}
