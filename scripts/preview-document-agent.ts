// Manual UI verification server. Ephemeral memory stores and deterministic model responses only.
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
process.env.STORAGE_LOCAL_ROOT = "data/agent-preview-assets";
process.env.ALLOWED_ORIGINS = "http://localhost:5178,http://127.0.0.1:5178";
const { bootstrap } = await import("../src/main.js");
const { LlmService } = await import("../src/ai/llm.service.js");
const { randomUUID } = await import("node:crypto");
const app = await bootstrap();
// Keep the fixture unmistakable when someone opens its UI outside the smoke test.
const { DocumentAgentService } = await import(
  "../src/ai/document-agent.service.js"
);
const agent = app.get(DocumentAgentService);
const capabilities = agent.capabilities.bind(agent);
agent.capabilities = async (context) => ({ ...await capabilities(context), preview: true });
app.get(LlmService).agentTurn = async (messages, tools) => {
  const context = JSON.parse(
    messages.find((m) => m.role === "user")?.content ?? "{}",
  );
  let name: string;
  let args: Record<string, unknown>;
  if (!tools.length)
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          passed: true,
          issues: [],
          strategy: "react",
          reason: "预览测试",
        }),
      },
      usage: {},
    };
  if (
    tools.some((t) => t.function.name === "propose_document_edits") &&
    context.query !== "改写当前文档内容"
  ) {
    name = "request_clarification";
    args = {
      question:
        "当前是界面测试服务，仅提供固定示例，不会按需求调用真实模型。请连接真实后端后继续。",
      choices: [],
    };
  } else if (tools.some((t) => t.function.name === "submit_plan")) {
    name = "submit_plan";
    args = {
      plan: {
        goal: "完善当前文档",
        outline: ["背景与目标", "设计方案", "实施与验证"],
        constraints: ["保留原有事实", "逐项预览采纳"],
        steps: [
          {
            id: "read",
            description: "读取当前文档",
            depends_on: [],
            capability: "read",
          },
          {
            id: "compose",
            description: "组织章节并生成修改建议",
            depends_on: ["read"],
            capability: "compose",
          },
        ],
      },
    };
  } else if (tools.some((t) => t.function.name === "propose_new_document")) {
    name = "propose_new_document";
    args = {
      title: "LiveDoc 文档工作台设计",
      markdown:
        "# LiveDoc 文档工作台设计\n\n## 背景与目标\n\n将资料阅读、知识检索和文档创作连接起来。\n\n## 设计方案\n\n通过 Ask、Plan 和 Agent 组织写作，正文修改先预览再采纳。\n\n## 实施与验证\n\n逐项采纳修改，保存为私有草稿，并使用分类整理文档。",
      citation_ids: [],
    };
  } else if (
    (tools.some((t) => t.function.name === "propose_document_edits") ||
      context.step?.capability === "read") &&
    !messages.some((m) => m.role === "tool")
  ) {
    name = "read_current_document";
    args = { region_ids: [] };
  } else if (tools.some((t) => t.function.name === "propose_document_edits")) {
    const regions = (context.regions ?? []).filter(
      (r: any) => r.type === "paragraph",
    );
    name = "propose_document_edits";
    args = {
      edits: regions.slice(0, 2).map((r: any, i: number) => ({
        id: `edit-${i}`,
        operation: "replace",
        target: { kind: "block_range", first_region_id: r.id },
        content_markdown: i
          ? "通过资料读取、知识检索和逐项采纳，将写作过程保持在用户控制之下。"
          : "LiveDoc 是一个面向个人知识管理和文档创作的智能工作台。",
        explanation: i ? "补充写作流程" : "明确项目定位",
        citation_ids: [],
      })),
    };
    if (!regions.length) {
      name = "request_clarification";
      args = {
        question: "请先在正文中添加一个段落，或选择新建独立文稿。",
        choices: ["新建独立文稿"],
      };
    }
  } else {
    name = "finish_answer";
    args = {
      answer:
        "当前文档可以围绕背景、设计方案与验证步骤组织。以上为预览测试响应。",
      citation_ids: [],
    };
  }
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
await app.listen({ host: "127.0.0.1", port: 8009 });
console.log("Ephemeral document-agent UI verification: http://127.0.0.1:8009");
const close = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
