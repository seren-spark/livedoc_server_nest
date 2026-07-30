import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AiWriteDto } from '../common/dto.js';
import type { AgentToolCall, WriteIntent } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { LlmService } from './llm.service.js';

type ToolName = AgentToolCall['name'];

const TOOL_TO_INTENT: Record<ToolName, WriteIntent> = {
  knowledge_search: 'knowledge_qa',
  summarize_document: 'summarize_document',
  continue_paragraph: 'continue_paragraph',
  format_selection: 'format_selection',
  fill_in_middle: 'fill_in_middle',
  correct_text: 'correct_text',
  expand_text: 'expand_text',
};

const INTENT_TO_TOOL: Record<WriteIntent, ToolName> = {
  knowledge_qa: 'knowledge_search',
  knowledge_search: 'knowledge_search',
  summarize_document: 'summarize_document',
  continue_paragraph: 'continue_paragraph',
  format_selection: 'format_selection',
  fill_in_middle: 'fill_in_middle',
  correct_text: 'correct_text',
  expand_text: 'expand_text',
};

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  knowledge_search: '检索有权限访问的知识库并生成带引用的回答。',
  summarize_document: '依据当前文档内容生成摘要，不引入外部事实。',
  continue_paragraph: '根据光标上下文和已授权资料续写当前段落。',
  format_selection: '只优化选中文本的结构与表达，保留原意和事实。',
  fill_in_middle: '根据光标前后文补全中间内容，只返回应插入的文本。',
  correct_text: '修正选中内容或当前文档的语法、拼写和表达问题。',
  expand_text: '在保持原意和文风的前提下扩写选中内容或当前文档。',
};

export const TOOL_DEFINITIONS = (Object.keys(TOOL_DESCRIPTIONS) as ToolName[]).map(
  (name) => {
    const retrieves = name === 'knowledge_search' || name === 'continue_paragraph';
    const properties: Record<string, unknown> = {
      query: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
    };
    if (retrieves) {
      properties.query_variants = {
        type: 'array',
        items: { type: 'string' },
        maxItems: 3,
        description: '保持原意的检索改写，不得删除精确标识符。',
      };
      properties.retrieval_domain = {
        type: 'string',
        enum: ['public', 'private', 'team', 'current_document'],
      };
    }
    return {
      type: 'function',
      function: {
        name,
        description: TOOL_DESCRIPTIONS[name],
        parameters: {
          type: 'object',
          properties,
          required: retrieves
            ? ['query', 'retrieval_domain', 'confidence', 'reason']
            : ['query', 'confidence', 'reason'],
        },
      },
    };
  },
);

@Injectable()
export class AgentToolsService {
  constructor(
    private readonly config: AppConfig,
    private readonly llm: LlmService,
  ) {}

  intentFor(call: AgentToolCall): WriteIntent {
    return TOOL_TO_INTENT[call.name];
  }

  async select(request: AiWriteDto): Promise<AgentToolCall> {
    const started = performance.now();
    if (request.intent) {
      return this.ruleCall(request, INTENT_TO_TOOL[request.intent], 'request_intent', '前端显式指定任务意图', 1, started);
    }
    if (['auto', 'llm'].includes(this.config.agentToolSelection) && this.llm.isConfigured) {
      try {
        const selected = await this.llm.selectTool(request, TOOL_DEFINITIONS);
        if (!(selected.name in TOOL_TO_INTENT)) throw new Error(`Unsupported tool: ${selected.name}`);
        const name = selected.name as ToolName;
        return {
          name,
          arguments: normalizeArguments(request, name, selected.arguments, this.config),
          reason: selected.reason || '模型根据任务语义选择工具',
          source: 'llm_function_call',
          confidence: clampConfidence(selected.arguments.confidence, 0.8),
          selection_ms: elapsed(started),
        };
      } catch (error) {
        if (this.config.agentToolSelection === 'llm') {
          throw new ServiceUnavailableException(
            `LLM tool selection failed: ${error instanceof Error ? error.constructor.name : 'Error'}`,
          );
        }
        const classification = classifyIntent(request.query, request.current_context.selected_text);
        return this.ruleCall(
          request,
          INTENT_TO_TOOL[classification.intent],
          'rule_fallback',
          `Function Call 不可用，规则降级：${error instanceof Error ? error.constructor.name : 'Error'}`,
          classification.confidence,
          started,
        );
      }
    }
    if (this.config.agentToolSelection === 'llm') {
      throw new ServiceUnavailableException('LLM tool selection is required but LLM is not configured');
    }
    const classification = classifyIntent(request.query, request.current_context.selected_text);
    return this.ruleCall(request, INTENT_TO_TOOL[classification.intent], 'rule_fallback', '未启用模型工具选择，使用可解释关键词路由', classification.confidence, started);
  }

  private ruleCall(
    request: AiWriteDto,
    name: ToolName,
    source: AgentToolCall['source'],
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
  summarize_document: ['总结', '摘要', '概括', 'summarize', 'summary'],
  format_selection: ['润色', '格式', '排版', '优化表达', '改写', 'format', 'polish'],
  fill_in_middle: ['中间补全', '光标补全', 'fim', 'fill in middle'],
  correct_text: ['改错', '纠错', '校对', '语法修正', 'proofread', 'correct'],
  expand_text: ['扩写', '扩充', '展开内容', 'expand text'],
  continue_paragraph: ['续写', '继续写', '补充', 'continue'],
  knowledge_search: ['检索', '查找', '找一下', '资料', '来源', '引用', 'search'],
};

export function classifyIntent(query: string, selectedText = ''): { intent: WriteIntent; confidence: number } {
  const text = `${query} ${selectedText}`.toLowerCase();
  const ranked = Object.entries(KEYWORDS)
    .map(([intent, keywords]) => ({ intent: intent as WriteIntent, matches: keywords.filter((item) => text.includes(item)).length }))
    .sort((a, b) => b.matches - a.matches);
  const best = ranked[0];
  if (!best?.matches) return { intent: 'knowledge_qa', confidence: 0.55 };
  const tied = ranked.filter((item) => item.matches === best.matches).length > 1;
  return { intent: best.intent, confidence: tied ? 0.45 : Math.min(0.95, 0.7 + 0.08 * (best.matches - 1)) };
}

export function normalizeArguments(
  request: AiWriteDto,
  name: ToolName,
  args: Record<string, any>,
  config: AppConfig,
): Record<string, unknown> {
  const query = request.query.trim();
  let domain = String(args.retrieval_domain ?? request.retrieval_domain);
  if (!['public', 'private', 'team', 'current_document'].includes(domain)) domain = request.retrieval_domain;
  if (['summarize_document', 'format_selection', 'fill_in_middle', 'correct_text', 'expand_text'].includes(name) && request.current_document) {
    domain = 'current_document';
  }
  const variants = normalizeQueryVariants(
    query,
    [args.query, ...(Array.isArray(args.query_variants) ? args.query_variants : [])],
    config.queryExpansionEnabled && ['knowledge_search', 'continue_paragraph'].includes(name),
    config.queryExpansionMaxVariants,
  );
  return { query, query_variants: variants, retrieval_domain: domain, selected_text_length: request.current_context.selected_text.length };
}

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
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim().replace(/\s+/g, ' ');
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key) || protectedTerms.some((term) => !normalized.includes(term))) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxVariants + 1) break;
  }
  return result;
}

export function extractProtectedTerms(query: string): string[] {
  const values: string[] = [];
  const quoted = /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|“([^”\r\n]+)”|‘([^’\r\n]+)’/gu;
  for (const match of query.matchAll(quoted)) {
    const value = match.slice(1).find(Boolean);
    if (value) values.push(value);
  }
  const exact = /(?<![A-Za-z0-9_])(?:[A-Za-z][A-Za-z0-9]*(?:[._:/-][A-Za-z0-9]+)+|[A-Z][A-Z0-9_]{2,}|[A-Za-z_]*\d+[A-Za-z0-9._:/-]*)(?![A-Za-z0-9_])/gu;
  values.push(...(query.match(exact) ?? []));
  return [...new Set(values)];
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function clampConfidence(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}
