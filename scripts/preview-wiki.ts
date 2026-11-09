// Isolated UI fixture: no real model, database, embeddings or existing documents.
process.env.NODE_ENV = "test";
process.env.RAG_RUNTIME_MODE = "test";
for (const key of [
  "METADATA_STORE",
  "MEMORY_STORE",
  "INDEX_JOB_STORE",
  "IMPORT_JOB_STORE",
  "OBSERVABILITY_STORE",
  "VECTOR_STORE",
])
  process.env[key] = "memory";
process.env.EMBEDDING_PROVIDER = "hash";
process.env.SPARSE_EMBEDDING_PROVIDER = "memory_bm25";
process.env.RERANK_PROVIDER = "heuristic";
process.env.MCP_ENABLED = "false";
process.env.LLM_API_KEY = "preview-only";
process.env.LLM_MODEL = "preview-fixture";
process.env.STORAGE_LOCAL_ROOT = "data/wiki-preview-assets";
process.env.ALLOWED_ORIGINS = "http://localhost:5178,http://127.0.0.1:5178";
const { bootstrap } = await import("../src/main.js");
const { LlmService } = await import("../src/ai/llm.service.js");
const { DocumentAgentService } = await import(
  "../src/ai/document-agent.service.js"
);
const { DocumentsService } = await import(
  "../src/documents/documents.service.js"
);
const { toIndexRequest } = await import("../src/documents/document.types.js");
const { RetrievalService } = await import(
  "../src/retrieval/retrieval.service.js"
);
const { randomUUID } = await import("node:crypto");
const app = await bootstrap();
const agent = app.get(DocumentAgentService);
const capabilities = agent.capabilities.bind(agent);
agent.capabilities = async (context) => ({
  ...(await capabilities(context)),
  preview: true,
});
const context = {
  user_id: "user_alice",
  space_id: "space_a",
  team_ids: ["team_alpha"],
};
const documents = app.get(DocumentsService);
const source = await documents.create(
  {
    title: "混合检索设计 · 界面验收专用",
    content:
      "混合检索采用向量检索理解语义，关键词检索补充精确匹配；两者通过 RRF 合并候选后重排。这是界面验收专用虚构资料。",
    source_type: "note",
    visibility: "private",
    tags: [],
    asset_ids: [],
    index_now: false,
  },
  context,
);
const count = await app
  .get(RetrievalService)
  .indexDocument(toIndexRequest(source));
await documents.markReady(source.doc_id, count, source.document_version);
app.get(LlmService).agentTurn = async (messages, tools, _signal, options) => {
  const payload = JSON.parse(
    messages.find((message) => message.role === "user")?.content ?? "{}",
  );
  let content: string | null = null;
  if (options?.role === "plan" && payload.sources) {
    const id = payload.sources[0].citation_id;
    content = JSON.stringify({
      title: "混合检索：语义与精确匹配",
      markdown: `# 混合检索\n\n向量检索理解语义，关键词检索补充精确匹配；两者通过 RRF 合并候选后重排。 [${id}]`,
      citation_ids: [id],
    });
  } else if (!tools.length) {
    content = JSON.stringify({
      passed: true,
      issues: [],
      quality: { reusable: true, complete: true, substantive: true },
      coverage: "full",
      missing: [],
      strategy: "react",
      reason: "界面验收固定响应",
    });
  }
  if (content) return { message: { role: "assistant", content }, usage: {} };
  const read = messages.find((message) => message.role === "tool");
  const citations = read ? JSON.parse(read.content!) : [];
  const name = read ? "finish_answer" : "search_knowledge_base";
  const args = read
    ? {
        answer: `向量检索与关键词检索互补，通过 RRF 合并候选后重排。 [citation_id:${citations[0].citation_id}]\n\n[citation_ids=${JSON.stringify([citations[0].citation_id])}]`,
        citation_ids: [citations[0].citation_id],
      }
    : { query: payload.query };
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: {},
  };
};
await app.listen({ host: "127.0.0.1", port: 8010 });
console.log(
  JSON.stringify({ preview: true, port: 8010, source_id: source.doc_id }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
