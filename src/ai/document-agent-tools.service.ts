import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
} from "@nestjs/common";
import { WikiService } from "../wiki/wiki.service.js";
import {
  isTimeSensitive,
  type WikiEvidence,
  type WikiCoverageResult,
} from "../wiki/wiki.types.js";
import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { AppConfig } from "../config/app-config.js";
import { DocumentsService } from "../documents/documents.service.js";
import { DocumentImportsService } from "../document-imports/document-imports.service.js";
import { RetrievalService } from "../retrieval/retrieval.service.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { LlmService } from "./llm.service.js";
import { AgentMcpService } from "./agent-mcp.service.js";
import {
  AgentSettingsService,
  PERSONAL_WEB_TOOLS,
} from "./agent-settings.service.js";
import type { AgentCitation, FunctionTool } from "./document-agent.types.js";
import { withAbort } from "./agent-runtime.types.js";
import {
  agentFailure,
  reserveWorkerModelBudget,
  startAgentSpan,
} from "./agent-execution.js";
import { workerHandoffSchema } from "./agent-handoff.js";
import { maxAgentPlanSteps } from "./document-agent.validation.js";
import type {
  WorkerInput,
  WorkerRole,
  WorkerState,
} from "./agent-runtime.types.js";

const str = { type: "string" };
const strings = { type: "array", items: str };
export const writingGuidance =
  "排版要求：正文使用可直接编辑的 Markdown，标题和段落之间留空行。整篇文章使用一个一级标题、清晰的二三级标题和适中的短段落；不要把所有信息挤成连续的大段文字。涉及多个方案、指标、维度或步骤的对比汇总时，优先使用有表头的 GFM 表格（| 列名 |），表格前后补充必要解读，不编造数据凑表格；不适合对比的叙事内容不强行制表。用 **加粗** 强调术语，用 ==高亮== 标记少量关键结论、决策或风险，每节通常不超过一处，禁止整段高亮。并列信息使用列表，提示可用引用块，代码使用带语言的围栏。不输出原始 HTML。对局部修改保留未涉及部分的结构和格式。用户明确指定的纯文本、篇幅、模板和排版要求优先。";
const planSchema = {
  type: "object",
  properties: {
    goal: str,
    outline: strings,
    constraints: strings,
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          id: str,
          description: str,
          depends_on: strings,
          capability: { enum: ["read", "search", "compose"] },
        },
        required: ["id", "description", "depends_on", "capability"],
        additionalProperties: false,
      },
    },
  },
  required: ["goal", "outline", "constraints", "steps"],
  additionalProperties: false,
};
function tool(
  name: string,
  description: string,
  properties: Record<string, any>,
  required: string[],
): FunctionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}
export const DOCUMENT_AGENT_TOOLS: FunctionTool[] = [
  tool(
    "read_current_document",
    "按区域读取当前快照；selection=true 精确读取选区。空 region_ids 按 offset 分页。超大块自动返回片段，用 region_ids=[该块id] 和 content_offset=next_content_offset 继续；全部片段读完才算已读整块。",
    {
      region_ids: { ...strings, maxItems: 200 },
      selection: { type: "boolean" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      content_offset: { type: "integer", minimum: 0 },
      content_limit: { type: "integer", minimum: 1, maximum: 16000 },
    },
    ["region_ids"],
  ),
  tool(
    "read_reference",
    "读取本轮所选资料，可按 offset 分页。",
    {
      reference_id: str,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 16000 },
    },
    ["reference_id"],
  ),
  tool(
    "read_knowledge_document",
    "分页读取本任务已从知识库检索到的文档原文，核实上下文。使用检索结果的 doc_id 和 next_offset；不能读取未检索到的任意文档。",
    {
      doc_id: str,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 16000 },
    },
    ["doc_id"],
  ),
  tool(
    "search_knowledge_base",
    "在已选知识范围先查有效 Wiki，缺失时查原始资料，返回真实来源。覆盖不足或需要原文时 original_only=true；最新价格政策等始终查原文。",
    { query: str, original_only: { type: "boolean" } },
    ["query"],
  ),
  tool("list_templates", "列出用户可用的写作模板。", {}, []),
  tool("read_template", "读取一个授权写作模板。", { template_id: str }, [
    "template_id",
  ]),
  tool("list_categories", "读取自己的私有文档分类。", {}, []),
  tool(
    "search_web",
    "联网搜索实时资料，返回检索摘要和真实网页来源；摘要中 [数字] 对应来源 index。",
    {
      query: { type: "string", minLength: 1, maxLength: 1000 },
    },
    ["query"],
  ),
  tool(
    "finish_answer",
    "提交只读回答或步骤结果；不要将建议描述成已经应用。",
    { answer: str, citation_ids: strings },
    ["answer", "citation_ids"],
  ),
  tool(
    "submit_plan",
    "提交计划并停止，只有用户确认后才执行。",
    { plan: planSchema },
    ["plan"],
  ),
  tool(
    "request_clarification",
    "信息不足时提交一个会影响结果的澄清问题并停止。",
    { question: str, choices: strings },
    ["question", "choices"],
  ),
  tool(
    "propose_new_document",
    "提交独立文稿，等待用户预览采纳，不直接创建。",
    { title: str, markdown: str, citation_ids: strings, category_id: str },
    ["title", "markdown", "citation_ids"],
  ),
  tool(
    "propose_document_edits",
    "提交针对基础快照的非重叠修改建议，不能写入正文。",
    {
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            id: str,
            operation: {
              enum: ["insert_before", "insert_after", "replace", "delete"],
            },
            target: {
              type: "object",
              properties: {
                kind: { enum: ["block_range", "selection", "cursor"] },
                first_region_id: str,
                last_region_id: str,
              },
              required: ["kind"],
              additionalProperties: false,
            },
            content_markdown: str,
            explanation: str,
            citation_ids: strings,
          },
          required: [
            "id",
            "operation",
            "target",
            "explanation",
            "citation_ids",
          ],
          additionalProperties: false,
        },
      },
    },
    ["edits"],
  ),
];

@Injectable()
export class DocumentAgentToolsService {
  private readonly tokenizer;
  constructor(
    private readonly config: AppConfig,
    private readonly documents: DocumentsService,
    private readonly imports: DocumentImportsService,
    private readonly retrieval: RetrievalService,
    private readonly workspace: WorkspaceService,
    private readonly llm: LlmService,
    private readonly mcp: AgentMcpService,
    private readonly settings: AgentSettingsService,
    @Optional() private readonly wiki?: WikiService,
  ) {
    this.tokenizer = getEncoding(
      config.tokenizerEncoding as Parameters<typeof getEncoding>[0],
    );
  }
  roleAllows(role: WorkerRole, name: string): boolean {
    if (role === "primary") return true;
    if (
      [
        "read_current_document",
        "read_reference",
        "read_knowledge_document",
        "finish_answer",
        "request_clarification",
      ].includes(name)
    )
      return true;
    if (role === "reader")
      return ["list_templates", "read_template"].includes(name);
    return (
      [
        "search_knowledge_base",
        "search_web",
        ...PERSONAL_WEB_TOOLS.map((t) => t.function.name),
      ].includes(name) || this.mcp.tools.get(name)?.research === true
    );
  }
  allowedTools(input: WorkerInput, all = false): FunctionTool[] {
    const { request, personal } = input.environment;
    const { step } = input;
    const keywords = request.query + (step?.description ?? "");
    return DOCUMENT_AGENT_TOOLS.filter((t) => {
      const name = t.function.name;
      if (
        input.environment.researchManaged &&
        input.role === "primary" &&
        name.startsWith("search_")
      )
        return false;
      if (
        [
          "finish_answer",
          "request_clarification",
          "read_current_document",
        ].includes(name)
      )
        return true;
      if (name === "submit_plan") return !step && request.mode === "plan";
      if (name.startsWith("propose_"))
        return (
          !step &&
          request.mode === "agent" &&
          (name === "propose_new_document") ===
            (request.output_target === "new_document")
        );
      if (name === "read_reference") return request.references.length > 0;
      if (name === "read_knowledge_document")
        return Boolean(request.knowledge_scope);
      if (name === "search_web")
        return (
          request.allow_web &&
          personal.deployment_web &&
          this.llm.webSearchConfigured
        );
      if (name === "search_knowledge_base")
        return Boolean(request.knowledge_scope);
      if (name.includes("template"))
        return (
          this.config.workspaceEnabled &&
          (Boolean(request.template_id) || all || /模板/u.test(keywords))
        );
      if (name === "list_categories")
        return (
          this.config.workspaceEnabled &&
          (all || /分类|目录归属/u.test(keywords))
        );
      return false;
    })
      .concat(
        request.allow_web &&
          (all ||
            step?.capability === "search" ||
            /联网|网页|最新|https?:|搜索/u.test(keywords))
          ? personal.deployment_web
            ? [...this.mcp.tools.values()].map((t) => t.schema)
            : []
          : [],
        request.allow_web && personal.web_key ? PERSONAL_WEB_TOOLS : [],
      )
      .filter(
        (t) =>
          this.roleAllows(input.role, t.function.name) &&
          !(
            input.environment.researchManaged &&
            input.role === "primary" &&
            (t.function.name.startsWith("personal_tavily_") ||
              t.function.name.startsWith("mcp__"))
          ),
      )
      .map((t) =>
        t.function.name === "submit_plan"
          ? {
              ...t,
              function: {
                ...t.function,
                parameters: {
                  ...t.function.parameters,
                  properties: {
                    plan: {
                      ...planSchema,
                      properties: {
                        ...planSchema.properties,
                        steps: {
                          ...planSchema.properties.steps,
                          maxItems: maxAgentPlanSteps(
                            this.config.agentMaxToolCalls,
                          ),
                        },
                      },
                    },
                  },
                },
              },
            }
          : step && t.function.name === "finish_answer"
            ? {
                ...t,
                function: {
                  ...t.function,
                  description:
                    "提交只读步骤结果和结构化交付。findings 逐项绑定已采用的证据；missing 明确缺口；conflicts 记录冲突，不能把执行成功描述为证据完整。",
                  parameters: {
                    ...t.function.parameters,
                    properties: {
                      ...t.function.parameters.properties,
                      handoff: workerHandoffSchema,
                    },
                    required: [...t.function.parameters.required, "handoff"],
                  },
                },
              }
            : t,
      );
  }

  async execute(
    input: WorkerInput,
    state: WorkerState,
    name: string,
    args: any,
    callId: string,
  ) {
    const { request, context, personal, signal } = input.environment;
    signal.throwIfAborted();
    if (!this.allowedTools(input, true).some((t) => t.function.name === name))
      throw new ForbiddenException("工具未加载或当前模式无权限");
    const { citations, evidence, readRegions } = state;
    const observe = (id: string, content: string) => {
      signal.throwIfAborted();
      if (
        !state.observations.some(
          (o) => o.citation_id === id && o.content === content,
        )
      ) {
        state.observations.push({ citation_id: id, content });
        evidence.set(
          id,
          evidence.has(id)
            ? evidence.get(id)! + "\n\n--- 本任务另一读取片段 ---\n" + content
            : content,
        );
      }
    };
    const addCitation = (c: AgentCitation) => {
      signal.throwIfAborted();
      if (!citations.has(c.id)) citations.set(c.id, c);
      return c.id;
    };
    const pageText = (content: string, offset: number, limit: number) => {
      let low = 0,
        high = Math.min(limit, Math.max(0, content.length - offset));
      const budget = Math.min(
        6000,
        Math.floor(this.config.llmContextWindow / 3),
      );
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
          this.tokenizer.encode(content.slice(offset, offset + middle))
            .length <= budget
        )
          low = middle;
        else high = middle - 1;
      }
      // Keep UTF-16 surrogate pairs intact at page boundaries.
      if (low && /[\uD800-\uDBFF]/.test(content[offset + low - 1]!)) low--;
      return content.slice(offset, offset + low);
    };
    const sourcePage = (
      prefix: string,
      content: string,
      metadata: Omit<AgentCitation, "id">,
      offset: number,
      limit: number,
    ) => {
      const page = pageText(content, offset, limit);
      if (!page && offset < content.length)
        throw new Error("读取预算不足以返回资料片段");
      const version =
        metadata.version ??
        createHash("sha256").update(content).digest("hex").slice(0, 12);
      const cid = addCitation({
        ...metadata,
        id: `${prefix}:${version}:${offset}:${offset + page.length}`,
        snippet: page.slice(0, 200),
        source_content: page,
        start_offset: offset,
        end_offset: offset + page.length,
      });
      observe(cid, page);
      return {
        citation_id: cid,
        content: page,
        offset,
        total_length: content.length,
        next_offset:
          offset + page.length < content.length ? offset + page.length : null,
      };
    };
    const readReference = async (id: string, offset = 0, limit = 5000) => {
      const ref = request.references.find((r) => r.id === id);
      if (!ref) throw new Error("仅可读取本轮选择的参考资料");
      let content: string;
      let version: number | undefined;
      let referenceTitle = ref.title;
      if (ref.kind === "document") {
        const d = await this.documents.getAccessible(ref.doc_id!, context);
        content = d.content;
        referenceTitle = d.title;
        version = d.document_version;
      } else if (ref.kind === "import") {
        const d = await this.imports.require(ref.import_id!);
        this.imports.assertOwner(d, context);
        if (d.document_id)
          await this.documents.getAccessible(d.document_id, context);
        if (!["review_ready", "confirmed"].includes(d.status))
          throw new Error("资料尚未解析完成");
        content = d.parsed_content;
        referenceTitle = d.title;
      } else content = ref.content!;
      return sourcePage(
        `ref-${id}`,
        content,
        {
          reference_id: id,
          title: referenceTitle,
          kind: ref.kind,
          doc_id: ref.doc_id,
          import_id: ref.import_id,
          version,
        },
        offset,
        limit,
      );
    };
    const execute = async () => {
      if (name === "read_current_document") {
        if (args.selection) {
          const selected = request.editor_snapshot.selection;
          if (!selected.text) throw new Error("当前没有文本选区");
          if (
            this.tokenizer.encode(selected.text).length >
            Math.min(8000, this.config.llmContextWindow / 3)
          )
            throw new Error("选区超过读取预算，请缩小选区或按区域读取");
          state.selectionRead = true;
          const citation_id = `current-${request.editor_snapshot.hash.slice(0, 12)}-selection`;
          observe(citation_id, selected.text);
          addCitation({
            id: citation_id,
            kind: "current_document",
            title: request.editor_snapshot.title || "当前选区",
            snippet: selected.text.slice(0, 200),
            source_content: selected.text,
            snapshot_hash: request.editor_snapshot.hash,
          });
          return {
            citation_id,
            selected_text: selected.text,
            inline: selected.inline,
            region_ids: selected.region_ids,
          };
        }
        const offset = args.offset ?? 0;
        const requested: string[] = args.region_ids.length
          ? args.region_ids
          : request.editor_snapshot.regions
              .slice(offset, offset + (args.limit ?? 200))
              .map((r) => r.id);
        if (
          requested.some(
            (id: string) =>
              !request.editor_snapshot.regions.some((r) => r.id === id),
          )
        )
          throw new Error("未知快照区域");
        const first = request.editor_snapshot.regions.find(
          (r) => r.id === requested[0],
        );
        if (args.content_offset !== undefined && requested.length !== 1)
          throw new Error("分段读取须用 region_ids 指定单个区域");
        if (
          first &&
          (args.content_offset !== undefined ||
            args.content_limit !== undefined ||
            this.tokenizer.encode(first.markdown).length >
              Math.min(8000, this.config.llmContextWindow / 3))
        ) {
          const start = args.content_offset ?? 0;
          const page = sourcePage(
            `current-${request.editor_snapshot.hash.slice(0, 12)}-${first.id}`,
            first.markdown,
            {
              kind: "current_document",
              title: request.editor_snapshot.title || "当前文档",
              snapshot_hash: request.editor_snapshot.hash,
              source_anchor: first.id,
              doc_id:
                request.editor_snapshot.identity.kind === "knowledge"
                  ? request.editor_snapshot.identity.doc_id
                  : undefined,
            },
            start,
            args.content_limit ?? 12000,
          );
          const ranges: Array<[number, number]> =
            (state.regionReadRanges ??= new Map()).get(first.id) ?? [];
          ranges.push([start, start + page.content.length]);
          ranges.sort((a, b) => a[0] - b[0]);
          let end = 0;
          for (const [from, to] of ranges) {
            if (from > end) break;
            end = Math.max(end, to);
          }
          state.regionReadRanges.set(first.id, ranges);
          if (end >= first.markdown.length) readRegions.add(first.id);
          return {
            ...page,
            region_id: first.id,
            regions: [{ id: first.id, markdown: page.content }],
            partial: !readRegions.has(first.id),
            read_region_ids: readRegions.has(first.id) ? [first.id] : [],
            unread_region_ids: requested.filter((id) => !readRegions.has(id)),
            unread_count:
              request.editor_snapshot.regions.length - readRegions.size,
            next_content_offset: page.next_offset,
            next_offset: args.region_ids.length
              ? null
              : page.next_offset === null
                ? offset + 1
                : offset,
          };
        }
        let used = 0;
        const regions: Array<{ id: string; markdown: string }> = [];
        for (const id of requested) {
          const r = request.editor_snapshot.regions.find((r) => r.id === id)!;
          const size = this.tokenizer.encode(r.markdown).length;
          if (used + size > Math.min(8000, this.config.llmContextWindow / 3))
            break;
          used += size;
          regions.push({ id: r.id, markdown: r.markdown });
        }
        if (!regions.length && requested.length)
          throw new Error("单个区域超过读取预算，请缩小编辑内容");
        const identity = request.editor_snapshot.identity;
        const sourceContent = regions.map((r) => r.markdown).join("\n\n");
        const citation_id = addCitation({
          id: `current-${request.editor_snapshot.hash.slice(0, 12)}-${createHash(
            "sha256",
          )
            .update(JSON.stringify(regions.map((r) => r.id)))
            .digest("hex")
            .slice(0, 12)}`,
          title: request.editor_snapshot.title || "当前文档",
          kind: "current_document",
          source_content: sourceContent,
          snapshot_hash: request.editor_snapshot.hash,
          snippet: request.editor_snapshot.regions
            .find((r) => regions.some((read) => read.id === r.id))
            ?.text.slice(0, 200),
          doc_id: identity.kind === "knowledge" ? identity.doc_id : undefined,
          version:
            identity.kind === "knowledge"
              ? identity.persisted_version
              : undefined,
        });
        regions.forEach((r) => readRegions.add(r.id));
        observe(citation_id, sourceContent);
        return {
          citation_id,
          regions,
          read_region_ids: regions.map((r) => r.id),
          unread_region_ids: requested.filter(
            (id: string) => !regions.some((r) => r.id === id),
          ),
          unread_count:
            request.editor_snapshot.regions.length - readRegions.size,
          next_offset: args.region_ids.length
            ? null
            : offset + regions.length < request.editor_snapshot.regions.length
              ? offset + regions.length
              : null,
        };
      }
      if (name === "read_reference")
        return readReference(
          args.reference_id,
          args.offset ?? 0,
          args.limit ?? 5000,
        );
      if (name === "read_knowledge_document") {
        const known = [...citations.values()].filter(
          (c) => c.kind === "document" && c.doc_id === args.doc_id,
        );
        if (!known.length)
          throw new ForbiddenException("仅可追读本任务已检索到的知识文档");
        const doc = await this.documents.getAccessible(args.doc_id, context);
        if (
          known.some(
            (c) =>
              c.version !== undefined && c.version !== doc.document_version,
          )
        )
          throw new ConflictException("参考资料版本已变更，请重新检索");
        return {
          doc_id: doc.doc_id,
          title: doc.title,
          ...sourcePage(
            `kb-doc-${doc.doc_id}`,
            doc.content,
            {
              kind: "document",
              doc_id: doc.doc_id,
              title: doc.title,
              version: doc.document_version,
            },
            args.offset ?? 0,
            args.limit ?? 5000,
          ),
        };
      }
      if (name === "search_knowledge_base")
        return this.searchEvidence(input, state, args, addCitation, observe);
      if (name === "list_templates")
        return (await this.workspace.listTemplates(context)).map((t) => ({
          template_id: t.template_id,
          name: t.name,
          description: t.description,
        }));
      if (name === "read_template")
        return this.workspace.getTemplate(context, args.template_id);
      if (name === "list_categories") return this.workspace.tree(context);
      if (name === "search_web") {
        if (
          !request.allow_web ||
          !personal.deployment_web ||
          !this.llm.webSearchConfigured
        )
          throw new ForbiddenException("联网搜索未配置或未启用");
        const settle = await reserveWorkerModelBudget(
          input.environment,
          this.tokenizer.encode(args.query).length + 1024,
          1800,
          {
            tokens: this.config.agentMaxTotalTokens,
            requests: this.config.agentMaxModelRequests - (input.role === "primary" ? 0 : 2),
          },
          input.role === "primary" ? 0 : this.config.agentFinalizationTokens,
        );
        if (input.usage) input.usage.model_requests++;
        const trace = startAgentSpan(
          input.environment,
          "model",
          "native_web_search",
          {
            model: this.config.agentWebSearchModel,
            attempt: 1,
            max_output_tokens: 1800,
          },
        );
        let result: Awaited<ReturnType<LlmService["searchWeb"]>>;
        try {
          result = await withAbort(
            this.llm.searchWeb(args.query, signal),
            signal,
          );
          signal.throwIfAborted();
          await settle(result.usage);
          Object.assign(trace.span.attributes, {
            prompt_tokens: Number(result.usage?.prompt_tokens ?? 0),
            completion_tokens: Number(result.usage?.completion_tokens ?? 0),
          });
          trace.finish();
        } catch (error) {
          await settle();
          trace.finish(error);
          throw error;
        }
        signal.throwIfAborted();
        for (const usage of [
          ...(input.environment.ledger ? [] : [input.environment.budget]),
          input.usage,
        ]) {
          if (!usage) continue;
          usage.prompt_tokens += Number(result.usage?.prompt_tokens ?? 0);
          usage.completion_tokens += Number(
            result.usage?.completion_tokens ?? 0,
          );
        }
        observe(
          `search-summary-${callId}`,
          `搜索服务的多来源汇总，不是单页原文：\n${result.summary}`,
        );
        return {
          summary: result.summary,
          summary_scope: "multi_source",
          sources: result.sources.map((source, i) => {
            const citation_id = addCitation({
              id: `web-${callId}-${i}`,
              title: source.title,
              kind: "web",
              url: source.url,
              source_content: source.content,
              snippet: source.content?.slice(0, 200),
              evidence_kind: "search_summary",
            });
            observe(
              citation_id,
              source.content ??
                `仅有搜索来源链接，未读取该网页原文：${source.title} ${source.url}`,
            );
            return { ...source, citation_id };
          }),
        };
      }
      if (name.startsWith("personal_tavily_")) {
        if (!request.allow_web || !personal.web_key)
          throw new ForbiddenException("联网搜索未配置或未启用");
        const results = await this.settings.webCall(
          name,
          args,
          personal.web_key,
          signal,
        );
        return {
          results: results.map(
            (r: { title: string; url: string; content: string }, i: number) => {
              const citation_id = addCitation({
                id: `web-${callId}-${i}`,
                title: r.title,
                kind: "web",
                url: r.url,
                source_content: r.content,
                snippet: r.content?.slice(0, 200),
                evidence_kind:
                  name === "personal_tavily_extract" && r.content
                    ? "source"
                    : "search_summary",
              });
              observe(citation_id, r.content);
              return { ...r, citation_id };
            },
          ),
        };
      }
      if (name.startsWith("mcp__")) {
        if (!request.allow_web) throw new ForbiddenException("联网资料未启用");
        const text = await this.mcp.call(name, args, signal);
        const urls = new Set<string>(
          [...text.matchAll(/https?:\/\/[^\s"<>\\]+/g)].map((m) => m[0]),
        );
        const citation_ids = [...urls].slice(0, 10).map((url, i) =>
          addCitation({
            id: `web-${callId}-${i}`,
            title: url,
            kind: "web",
            url,
            evidence_kind: "tool_output",
          }),
        );
        observe(
          `tool-output-${callId}`,
          `工具返回的整体内容，不代表每个链接的独立原文：\n${text.slice(0, 5000)}`,
        );
        citation_ids.forEach((id, i) =>
          observe(id, `工具返回的链接，未取得独立原文片段：${[...urls][i]}`),
        );
        return {
          content: text.slice(0, 24000),
          truncated: text.length > 24000,
          citation_ids,
        };
      }
      throw new Error("未知读取工具");
    };
    const value = await execute();
    signal.throwIfAborted();
    return value;
  }
  async searchEvidence(
    input: WorkerInput,
    state: WorkerState,
    args: any,
    addCitation: (citation: AgentCitation) => string,
    observe: (id: string, content: string) => void,
  ) {
    const { request, context, signal } = input.environment;

    if (!request.knowledge_scope)
      throw new Error("用户未选择知识库范围；请使用当前正文或已选资料");
    const scope = {
      ...request.knowledge_scope,
      document_ids: request.knowledge_scope.document_ids ?? [],
    };
    // Initial retrieval is Wiki-first unless the user explicitly requests originals.
    // A model may request originals after this task has actually considered Wiki.
    const originalOnly =
      args.original_only &&
      (state.wikiChecks.length > 0 ||
        state.wikiReads.length > 0 ||
        state.wikiFallbacks.length > 0 ||
        /原文|原始资料|原始文档|\boriginal\b|\braw\b/i.test(request.query));
    let partialPages: WikiEvidence[] = [];
    let partialCoverage: WikiCoverageResult | undefined;
    const wikiRows = (pages: WikiEvidence[], coverage: WikiCoverageResult) =>
      pages.flatMap((page) =>
        page.citations.map((citation, index) => ({
          citation_id: citation.id,
          content: citation.source_content,
          doc_id: citation.doc_id,
          title: citation.title,
          knowledge_layer: "wiki",
          wiki_id: page.proof.wiki_id,
          wiki_summary: index === 0 ? page.markdown : undefined,
          wiki_coverage: index === 0 ? coverage.coverage : undefined,
          missing: index === 0 ? coverage.missing : undefined,
          note: "Wiki 是整理层，引用对应原始证据。partial 表示仍有缺失；结合补充原文回答，未找到的内容明确说明，不能用常识补齐。",
        })),
      );
    const fits = (rows: unknown[]) =>
      this.tokenizer.encode(JSON.stringify(rows)).length <=
      Math.min(10000, this.config.llmContextWindow / 2);
    const adoptWiki = (pages: WikiEvidence[]) => {
      for (const page of pages) {
        if (
          !state.wikiReads.some(
            (proof) =>
              proof.wiki_id === page.proof.wiki_id &&
              proof.revision === page.proof.revision,
          )
        )
          state.wikiReads.push(page.proof);
        for (const citation of page.citations) {
          addCitation(citation);
          observe(citation.id, citation.source_content!);
        }
      }
    };
    if (
      this.wiki &&
      input.environment.knowledge_snapshot !== null &&
      !originalOnly &&
      !isTimeSensitive(request.query)
    ) {
      // Reserve half of the existing 30s tool deadline for original retrieval.
      const wikiTimeout = AbortSignal.timeout(15000);
      const wikiSignal = AbortSignal.any([signal, wikiTimeout]);
      try {
        const pages = await withAbort(
          this.wiki.search(args.query, scope, context, wikiSignal),
          wikiSignal,
        );
        signal.throwIfAborted();
        if (pages.length) {
          const totals = [input.environment.budget];
          if (input.usage) totals.push(input.usage);
          const coverage = await withAbort(
            this.wiki.coverage(
              request.query,
              args.query,
              pages,
              wikiSignal,
              totals,
              input.environment.model_turn,
            ),
            wikiSignal,
          );
          signal.throwIfAborted();
          state.wikiChecks.push({
            wiki_id: pages[0]!.proof.wiki_id,
            wiki_ids: pages.map((page) => page.proof.wiki_id),
            query: args.query,
            ...coverage,
          });
          if (coverage.coverage === "full") {
            const rows = wikiRows(pages, coverage);
            if (fits(rows)) {
              await withAbort(
                this.wiki.validateProofs(
                  pages.map((page) => page.proof),
                  context,
                  input.environment.knowledge_snapshot,
                ),
                wikiSignal,
              );
              signal.throwIfAborted();
              adoptWiki(pages);
              return rows;
            }
            state.wikiFallbacks.push("context_budget");
          } else if (coverage.coverage === "partial") {
            partialPages = pages;
            partialCoverage = coverage;
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        if (agentFailure(error).code === "AGENT_BUDGET_EXCEEDED") throw error;
        state.wikiFallbacks.push(
          wikiTimeout.aborted ? "timeout" : "unavailable",
        );
      }
    }
    signal.throwIfAborted();
    const result = await this.retrieval.searchWithTrace(
      {
        query: partialCoverage
          ? `${args.query}\n待补充的信息：${partialCoverage.missing.join("；")}`
          : args.query,
        scope,
        top_k: 5,
        mode: "hybrid",
        context: request.query,
      } as any,
      context,
    );
    signal.throwIfAborted();
    for (const c of result.citations) observe(`kb-${c.citation_id}`, c.content);
    const rawRows = result.citations.map((c) => ({
      citation_id: addCitation({
        id: `kb-${c.citation_id}`,
        title: c.title,
        kind: "document",
        doc_id: c.doc_id,
        version: c.document_version,
        url: c.url ?? undefined,
        snippet: c.snippet,
        source_content: c.source_content ?? c.content,
        start_offset: c.start_offset ?? undefined,
        end_offset: c.end_offset ?? undefined,
        source_anchor: c.source_anchor,
      }),
      content: c.content,
      doc_id: c.doc_id,
      title: c.title,
    }));
    if (partialCoverage && partialPages.length) {
      const combined = [...wikiRows(partialPages, partialCoverage), ...rawRows];
      if (fits(combined)) {
        try {
          await withAbort(
            this.wiki!.validateProofs(
              partialPages.map((page) => page.proof),
              context,
              input.environment.knowledge_snapshot,
            ),
            signal,
          );
          signal.throwIfAborted();
          adoptWiki(partialPages);
          return combined;
        } catch {
          signal.throwIfAborted();
          state.wikiFallbacks.push("unavailable");
        }
      } else state.wikiFallbacks.push("context_budget");
    }
    return rawRows;
  }
}
