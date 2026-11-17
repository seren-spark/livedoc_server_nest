/**
 * @file 写作意图与检索参数。识别写作请求的意图，准备检索范围、查询变体和置信度。
 */
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { validateAgentToolArguments, type AiWriteDto } from "../common/dto.js";
import type { AgentToolCall, WriteIntent } from "../common/types.js";
import { AppConfig } from "../config/app-config.js";
import { LlmService } from "./llm.service.js";
import {
  AGENT_TOOL_DEFINITIONS,
  LlmToolName,
  type AgentToolName,
} from './llm-tools.js';

const TOOL_TO_INTENT: Record<AgentToolName, WriteIntent> = {
  [LlmToolName.SearchKnowledgeBase]: "knowledge_qa",
  [LlmToolName.SummarizeCurrentDocument]: "summarize_document",
  [LlmToolName.ContinueParagraph]: "continue_paragraph",
  [LlmToolName.OptimizeFormat]: "format_selection",
};

const INTENT_TO_TOOL: Record<WriteIntent, AgentToolName> = {
  knowledge_qa: LlmToolName.SearchKnowledgeBase,
  knowledge_search: LlmToolName.SearchKnowledgeBase,
  summarize_document: LlmToolName.SummarizeCurrentDocument,
  continue_paragraph: LlmToolName.ContinueParagraph,
  format_selection: LlmToolName.OptimizeFormat,
  fill_in_middle: LlmToolName.OptimizeFormat,
  correct_text: LlmToolName.OptimizeFormat,
  expand_text: LlmToolName.OptimizeFormat,
};

const LEGACY_TOOL_DESCRIPTIONS: Record<string, string> = {
  knowledge_search: "检索有权限访问的知识库并生成带引用的回答。",
  summarize_document: "依据当前文档内容生成摘要，不引入外部事实。",
  continue_paragraph: "根据光标上下文和已授权资料续写当前段落。",
  format_selection: "只优化选中文本的结构与表达，保留原意和事实。",
  fill_in_middle: "根据光标前后文补全中间内容，只返回应插入的文本。",
  correct_text: "修正选中内容或当前文档的语法、拼写和表达问题。",
  expand_text: "在保持原意和文风的前提下扩写选中内容或当前文档。",
};

void LEGACY_TOOL_DESCRIPTIONS;

export { AGENT_TOOL_DEFINITIONS as TOOL_DEFINITIONS };

@Injectable()
export class AgentToolsService {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param llm 共享模型调用服务。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly llm: LlmService,
  ) {}

  /**
   * 把工具调用或分类结果映射到写作业务意图。
   *
   * @param call 执行一次模型或工具调用的回调。
   * @returns WriteIntent 类型的处理结果。
   */
  intentFor(call: AgentToolCall): WriteIntent {
    return TOOL_TO_INTENT[call.name];
  }

  /**
   * 选择一个工具调用
   * @param  request 任务请求
   * @returns 选中的工具调用
   */
  async select(request: AiWriteDto): Promise<AgentToolCall> {
    const started = performance.now();
    //如果前端已经传了 intent （如 correct_text ），直接查表 INTENT_TO_TOOL 映射到工具名
    if (request.intent && this.config.runtimeMode !== "real") {
      return this.ruleCall(
        request,
        INTENT_TO_TOOL[request.intent],
        "request_intent",
        "前端显式指定任务意图",
        1,
        started,
      );
    }
    if (
      ["auto", "llm"].includes(this.config.agentToolSelection) &&
      this.llm.isConfigured
    ) {
      try {
        const selected = await this.llm.selectTool(request, AGENT_TOOL_DEFINITIONS);
        //校验模型返回的工具名是否在支持的列表里，防止模型瞎返回。
        if (!(selected.name in TOOL_TO_INTENT))
          throw new Error(`Unsupported tool: ${selected.name}`);
        const name = selected.name as AgentToolName;
        //对模型返回的参数做 schema 校验
        const validated = await validateAgentToolArguments(
          {
            ...selected.arguments,
            reason: selected.reason || selected.arguments.reason,
          },
          name === LlmToolName.SearchKnowledgeBase ||
            name === LlmToolName.ContinueParagraph,
        );

        //返回结构化结果
        // arguments ：标准化参数（query、retrieval_domain、query_variants 等）
        // source: 'llm_function_call' ：标记来源是 LLM
        // confidence ：取模型返回的置信度（限制在 0-1 范围），默认 0.8
        return {
          name,
          arguments: normalizeArguments(
            request,
            name,
            validated as unknown as Record<string, any>,
            this.config,
          ),
          reason: selected.reason || "模型根据任务语义选择工具",
          source: "llm_function_call",
          confidence: clampConfidence(selected.arguments.confidence, 0.8),
          selection_ms: elapsed(started),
        };
      } catch (error) {
        //如果配置是 'llm' （强制要求用 LLM），失败直接抛 503 错误
        if (this.config.agentToolSelection === "llm") {
          const detail = error instanceof Error ? error.message : String(error);
          throw new ServiceUnavailableException(
            `LLM tool selection failed: ${detail.slice(0, 500)}`,
          );
        }
        //调用 classifyIntent （关键词匹配）判断意图
        //source: 'rule_fallback' ：标记是从 LLM 降级的
        //reason 里记录失败原因
        const classification = classifyIntent(
          request.query,
          request.current_context.selected_text,
        );
        return this.ruleCall(
          request,
          INTENT_TO_TOOL[classification.intent],
          "rule_fallback",
          `Function Call 不可用，规则降级：${error instanceof Error ? error.constructor.name : "Error"}`,
          classification.confidence,
          started,
        );
      }
    }
    if (this.config.agentToolSelection === "llm") {
      throw new ServiceUnavailableException(
        "LLM tool selection is required but LLM is not configured",
      );
    }
    //调用 classifyIntent （关键词匹配）判断意图
    const classification = classifyIntent(
      request.query,
      request.current_context.selected_text,
    );
    return this.ruleCall(
      request,
      INTENT_TO_TOOL[classification.intent],
      "rule_fallback",
      "未启用模型工具选择，使用可解释关键词路由",
      classification.confidence,
      started,
    );
  }

  /**
   * 用明确的请求规则构造工具调用，减少不必要的模型分类。
   *
   * @param request 当前业务请求。
   * @param name 目标名称。
   * @param source 当前来源内容或来源记录。
   * @param reason 当前判断或失败的原因。
   * @param confidence 当前分类或记忆项的置信度。
   * @param started 当前操作的起始计时点。
   * @returns AgentToolCall 类型的处理结果。
   */
  private ruleCall(
    request: AiWriteDto,
    name: AgentToolName,
    source: AgentToolCall["source"],
    reason: string,
    confidence: number,
    started: number,
  ): AgentToolCall {
    return {
      name,
      arguments: normalizeArguments(request, name, {}, this.config),
      reason,
      source,
      confidence,
      selection_ms: elapsed(started),
    };
  }
}

const KEYWORDS: Partial<Record<WriteIntent, string[]>> = {
  summarize_document: ["总结", "摘要", "概括", "summarize", "summary"],
  format_selection: [
    "润色",
    "格式",
    "排版",
    "优化表达",
    "改写",
    "format",
    "polish",
  ],
  fill_in_middle: ["中间补全", "光标补全", "fim", "fill in middle"],
  correct_text: ["改错", "纠错", "校对", "语法修正", "proofread", "correct"],
  expand_text: ["扩写", "扩充", "展开内容", "expand text"],
  continue_paragraph: ["续写", "继续写", "补充", "continue"],
  knowledge_search: [
    "检索",
    "查找",
    "找一下",
    "资料",
    "来源",
    "引用",
    "search",
  ],
};

/**
 * 调用分类模型识别写作意图并整理检索参数。
 *
 * @param query 用户问题或检索查询。
 * @param selectedText 当前选中的原文文本。
 * @returns 整理后的状态与操作结果对象。
 */
export function classifyIntent(
  query: string,
  selectedText = "",
): { intent: WriteIntent; confidence: number } {
  const text = `${query} ${selectedText}`.toLowerCase();
  //遍历 7 个意图的关键词列表，统计每个意图命中了多少个关键词，按命中数降序排序。
  const ranked = Object.entries(KEYWORDS)
    .map(([intent, keywords]) => ({
      intent: intent as WriteIntent,
      matches: keywords.filter((item) => text.includes(item)).length,
    }))
    .sort((a, b) => b.matches - a.matches);
  const best = ranked[0];
  //如果所有意图都没命中关键词（ best.matches === 0 ），默认返回 knowledge_qa （知识问答），置信度 0.55（较低，表示不确定）
  if (!best?.matches) return { intent: "knowledge_qa", confidence: 0.55 };
  const tied =
    ranked.filter((item) => item.matches === best.matches).length > 1;
  return {
    intent: best.intent,
    confidence: tied ? 0.45 : Math.min(0.95, 0.7 + 0.08 * (best.matches - 1)),
  };
}

/**
 * 对 query 和 query_variants 做参数标准化
 * @param request 任务请求
 * @param name 工具名称
 * @param args 工具参数
 * @param config 配置
 * @returns 标准化后的参数
 */
export function normalizeArguments(
  request: AiWriteDto,
  name: AgentToolName,
  args: Record<string, any>,
  config: AppConfig,
): Record<string, unknown> {
  const query = request.query.trim();
  let domain = String(args.retrieval_domain ?? request.retrieval_domain);
  if (!["public", "private", "team", "current_document"].includes(domain))
    domain = request.retrieval_domain;
  if (
    ([
      LlmToolName.SummarizeCurrentDocument,
      LlmToolName.OptimizeFormat,
    ] as AgentToolName[]).includes(name) &&
    request.current_document
  ) {
    domain = "current_document";
  }
  const variants = normalizeQueryVariants(
    query,
    [
      args.query,
      ...(Array.isArray(args.query_variants) ? args.query_variants : []),
    ],
    config.queryExpansionEnabled &&
      ([
        LlmToolName.SearchKnowledgeBase,
        LlmToolName.ContinueParagraph,
      ] as AgentToolName[]).includes(name),
    config.queryExpansionMaxVariants,
  );
  return {
    query,
    query_variants: variants,
    retrieval_domain: domain,
    selected_text_length: request.current_context.selected_text.length,
  };
}

/**
 * 去除空白与重复查询，保留可用于召回的查询变体。
 *
 * @param original 处理前保存的原始内容。
 * @param candidates 待筛选的候选集合。
 * @param enabled 是否启用当前功能。
 * @param maxVariants maxVariants 对应的数量或范围限制。
 * @returns 整理后的字符串列表。
 */
export function normalizeQueryVariants(
  original: string,
  candidates: unknown[],
  enabled: boolean,
  maxVariants = 3,
): string[] {
  const query = original.trim();
  const result = query ? [query] : [];
  if (!enabled) return result;
  const protectedTerms = extractProtectedTerms(query);
  const seen = new Set(result.map((item) => item.toLocaleLowerCase()));
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().replace(/\s+/g, " ");
    const key = normalized.toLocaleLowerCase();
    if (
      !normalized ||
      seen.has(key) ||
      protectedTerms.some((term) => !normalized.includes(term))
    )
      continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxVariants + 1) break;
  }
  return result;
}

/**
 * 提取查询中不应在改写时丢失的术语或代码标识。
 *
 * @param query 用户问题或检索查询。
 * @returns 整理后的字符串列表。
 */
export function extractProtectedTerms(query: string): string[] {
  const values: string[] = [];
  const quoted =
    /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|“([^”\r\n]+)”|‘([^’\r\n]+)’/gu;
  for (const match of query.matchAll(quoted)) {
    const value = match.slice(1).find(Boolean);
    if (value) values.push(value);
  }
  const exact =
    /(?<![A-Za-z0-9_])(?:[A-Za-z][A-Za-z0-9]*(?:[._:/-][A-Za-z0-9]+)+|[A-Z][A-Z0-9_]{2,}|[A-Za-z_]*\d+[A-Za-z0-9._:/-]*)(?![A-Za-z0-9_])/gu;
  values.push(...(query.match(exact) ?? []));
  return [...new Set(values)];
}

/**
 * 计算当前操作已消耗的时间。
 *
 * @param started 当前操作的起始计时点。
 * @returns 计算得到的数值。
 */
function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

/**
 * 将分类置信度限制到合法数值范围。
 *
 * @param value 待校验或转换的值。
 * @param fallback 首选路径不可用时采用的回退值。
 * @returns 计算得到的数值。
 */
function clampConfidence(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}
