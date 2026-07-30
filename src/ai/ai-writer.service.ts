import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AiWriteDto, SearchDto } from '../common/dto.js';
import type {
  AccessContext,
  AgentToolCall,
  Citation,
  KnowledgeScope,
  RetrievalTrace,
  WriteIntent,
} from '../common/types.js';
import { ObservabilityService } from '../observability/observability.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { AgentToolsService } from './agent-tools.service.js';
import { LlmService } from './llm.service.js';
import { ConversationMemoryService } from './memory.service.js';

export const NO_EVIDENCE_MESSAGE = '知识库未查询到相关依据，无法作答';
const EDITOR_INTENTS = new Set<WriteIntent>([
  'summarize_document',
  'format_selection',
  'fill_in_middle',
  'correct_text',
  'expand_text',
]);
const KNOWLEDGE_INTENTS = new Set<WriteIntent>(['knowledge_qa', 'knowledge_search']);

export interface SseMessage {
  event: 'tool_call' | 'tool_result' | 'meta' | 'delta' | 'done' | 'error';
  data: unknown;
}

@Injectable()
export class AiWriterService {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly memory: ConversationMemoryService,
    private readonly llm: LlmService,
    private readonly tools: AgentToolsService,
    private readonly observability: ObservabilityService,
  ) {}

  async complete(request: AiWriteDto, context: AccessContext, signal?: AbortSignal) {
    const prepared = await this.prepare(request, context);
    if (!prepared.citations.length && KNOWLEDGE_INTENTS.has(prepared.intent)) {
      await this.observability.recordCompletion(prepared.trace.trace_id, prepared.toolCall.name, false);
      return {
        intent: prepared.intent,
        tool_call: prepared.toolCall,
        trace: prepared.trace,
        answer: NO_EVIDENCE_MESSAGE,
        citations: [],
      };
    }
    const started = performance.now();
    try {
      const answer = await this.llm.complete(prepared.prompt, signal);
      await this.remember(request, answer, context);
      await this.observability.recordCompletion(
        prepared.trace.trace_id,
        prepared.toolCall.name,
        true,
        performance.now() - started,
      );
      return {
        intent: prepared.intent,
        tool_call: prepared.toolCall,
        trace: prepared.trace,
        answer,
        citations: prepared.citations,
      };
    } catch (error) {
      await this.observability.recordCompletion(
        prepared.trace.trace_id,
        prepared.toolCall.name,
        Boolean(prepared.citations.length),
        performance.now() - started,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async *stream(request: AiWriteDto, context: AccessContext, signal?: AbortSignal): AsyncGenerator<SseMessage> {
    let prepared: Awaited<ReturnType<AiWriterService['prepare']>> | undefined;
    try {
      prepared = await this.prepare(request, context);
      if (request.conversation_id) await this.memory.add(request.conversation_id, 'user', request.query, context);
      yield { event: 'tool_call', data: prepared.toolCall };
      yield {
        event: 'tool_result',
        data: {
          name: prepared.toolCall.name,
          trace_id: prepared.trace.trace_id,
          has_evidence: Boolean(prepared.citations.length),
          citation_count: prepared.citations.length,
          duration_ms: prepared.trace.total_ms,
        },
      };
      yield {
        event: 'meta',
        data: {
          intent: prepared.intent,
          tool_call: prepared.toolCall,
          retrieval_trace: prepared.trace,
          citations: prepared.citations,
          retrieved_document_count: new Set(prepared.citations.map((item) => item.doc_id)).size,
        },
      };
      if (!prepared.citations.length && KNOWLEDGE_INTENTS.has(prepared.intent)) {
        yield { event: 'delta', data: NO_EVIDENCE_MESSAGE };
        yield { event: 'done', data: { status: 'done', has_evidence: false, trace_id: prepared.trace.trace_id } };
        await this.observability.recordCompletion(prepared.trace.trace_id, prepared.toolCall.name, false);
        if (request.conversation_id) await this.memory.add(request.conversation_id, 'assistant', NO_EVIDENCE_MESSAGE, context);
        return;
      }
      const answer: string[] = [];
      const started = performance.now();
      for await (const delta of this.llm.stream(prepared.prompt, signal)) {
        answer.push(delta);
        yield { event: 'delta', data: delta };
      }
      yield {
        event: 'done',
        data: { status: 'done', has_evidence: Boolean(prepared.citations.length), trace_id: prepared.trace.trace_id },
      };
      await this.observability.recordCompletion(
        prepared.trace.trace_id,
        prepared.toolCall.name,
        Boolean(prepared.citations.length),
        performance.now() - started,
      );
      if (request.conversation_id) await this.memory.add(request.conversation_id, 'assistant', answer.join(''), context);
    } catch (error) {
      if (prepared) {
        await this.observability.recordCompletion(
          prepared.trace.trace_id,
          prepared.toolCall.name,
          Boolean(prepared.citations.length),
          0,
          error instanceof Error ? error.message : String(error),
        );
      }
      yield { event: 'error', data: { message: error instanceof Error ? error.message : '生成失败，请稍后重试' } };
    }
  }

  private async prepare(request: AiWriteDto, context: AccessContext) {
    const toolCall = await this.tools.select(request);
    const intent = this.tools.intentFor(toolCall);
    const effective = {
      ...request,
      intent,
      query: String(toolCall.arguments.query),
      retrieval_domain: toolCall.arguments.retrieval_domain as AiWriteDto['retrieval_domain'],
    };
    const memoryText = await this.memory.recentText(request.conversation_id, context);
    const searchQuery = buildSearchQuery(effective, memoryText);
    const contextText = buildContextText(effective, memoryText);
    let citations: Citation[];
    let trace: RetrievalTrace;
    if (EDITOR_INTENTS.has(intent)) {
      citations = buildEditorCitations(effective, context);
      trace = {
        trace_id: randomUUID().replaceAll('-', ''),
        mode: 'hybrid',
        rewritten_query: effective.query.trim(),
        query_variants: [effective.query.trim()],
        expansion_source: 'original',
        expansion_enabled: false,
        dense_candidates: 0,
        keyword_candidates: 0,
        fused_candidates: 0,
        reranked_candidates: 0,
        deduped_candidates: 0,
        returned_citations: citations.length,
        retrieval_ms: 0,
        rerank_ms: 0,
        compression_ms: 0,
        preprocessing_ms: toolCall.selection_ms,
        total_ms: toolCall.selection_ms,
      };
      await this.observability.recordSearch(trace, context, request.query, citations, 'editor_context');
    } else if (effective.retrieval_domain === 'current_document') {
      const result = await this.retrieval.searchCurrentDocumentWithTrace({
        query: searchQuery,
        title: effective.current_document?.title ?? effective.current_context.title,
        content: effective.current_document?.content ?? '',
        topK: 5,
        contextText,
        queryVariants: toolCall.arguments.query_variants as string[],
        expansionSource: toolCall.source === 'llm_function_call' ? 'tool_call' : toolCall.source === 'rule_fallback' ? 'fallback' : 'original',
        preprocessingMs: toolCall.selection_ms,
        context,
      });
      citations = result.citations;
      trace = result.trace;
    } else {
      const result = await this.retrieval.searchWithTrace(
        {
          query: searchQuery,
          context: contextText,
          scope: scopeForDomain(effective.retrieval_domain),
          top_k: 5,
          mode: 'hybrid',
        } as SearchDto,
        context,
        toolCall.arguments.query_variants as string[],
        toolCall.source === 'llm_function_call' ? 'tool_call' : toolCall.source === 'rule_fallback' ? 'fallback' : 'original',
        toolCall.selection_ms,
      );
      citations = result.citations;
      trace = result.trace;
    }
    return {
      prompt: buildRagPrompt(effective, citations, intent, memoryText),
      citations,
      intent,
      toolCall,
      trace,
    };
  }

  private async remember(request: AiWriteDto, answer: string, context: AccessContext): Promise<void> {
    if (!request.conversation_id) return;
    await this.memory.add(request.conversation_id, 'user', request.query, context);
    await this.memory.add(request.conversation_id, 'assistant', answer, context);
  }
}

export function buildEditorCitations(request: AiWriteDto, context: AccessContext): Citation[] {
  const source =
    request.current_context.selected_text.trim() ||
    request.current_document?.content.trim() ||
    [request.current_context.cursor_before, request.current_context.cursor_after].filter((item) => item.trim()).join('\n').trim();
  if (!source) return [];
  return [
    {
      index: 1,
      doc_id: 'current_document',
      chunk_id: 'editor_context',
      title: request.current_document?.title ?? request.current_context.title ?? '当前打开文档',
      content: source.slice(0, 12_000),
      source_type: 'current_document',
      visibility: 'private',
      score: 1,
      heading_path: [],
      chunk_index: 0,
      space_id: context.space_id,
      team_id: null,
      document_version: 1,
    },
  ];
}

export function scopeForDomain(domain: AiWriteDto['retrieval_domain']): KnowledgeScope {
  return { public: domain === 'public', private: domain === 'private', team: domain === 'team', document_ids: [] };
}

function buildSearchQuery(request: AiWriteDto, memoryText: string): string {
  const context = request.current_context;
  return [
    request.query,
    context.title,
    context.tags.join(' '),
    context.cursor_before.slice(-500),
    context.selected_text,
    memoryText.slice(-500),
  ].filter(Boolean).join('\n');
}

function buildContextText(request: AiWriteDto, memoryText: string): string {
  const context = request.current_context;
  return [
    `title: ${context.title}`,
    `tags: ${context.tags.join(' ')}`,
    `cursor_before: ${context.cursor_before.slice(-800)}`,
    `cursor_after: ${context.cursor_after.slice(0, 400)}`,
    `selected_text: ${context.selected_text}`,
    `recent_memory: ${memoryText.slice(-800)}`,
  ].filter((item) => !item.endsWith(': ')).join('\n');
}

const TASK_INSTRUCTIONS: Record<WriteIntent, string> = {
  knowledge_qa: '依据资料回答问题，使用 [1]、[2] 标注来源。',
  knowledge_search: '依据资料回答问题，使用 [1]、[2] 标注来源。',
  continue_paragraph: '续写光标前的段落，并自然衔接光标后的内容；只返回新增文本。',
  summarize_document: '概括当前文档；不得加入文档中不存在的事实。',
  format_selection: '优化选中文本的结构和表达；只返回可替换原选区的文本。',
  fill_in_middle: '补全光标前后文之间的缺失内容；只返回需要插入的文本。',
  correct_text: '修正语法、拼写、标点和表达问题；只返回修正后的完整目标文本。',
  expand_text: '保持原意、事实和文风进行扩写；只返回可替换目标内容的文本。',
};

function buildRagPrompt(request: AiWriteDto, citations: Citation[], intent: WriteIntent, memoryText: string): string {
  const context = request.current_context;
  const evidence = citations.length
    ? citations.map((item) => [
        `[${item.index}] ${item.title}`,
        `来源：${item.source_type} / ${item.visibility}`,
        `版本：v${item.document_version}`,
        `位置：chunk ${item.chunk_index ?? '未知'}`,
        `路径：${item.heading_path.join(' > ') || '无'}`,
        `内容：${item.content}`,
      ].join('\n')).join('\n\n')
    : '无可用资料';
  return `你是 LiveDoc 的企业知识库写作助手。任务意图：${intent}

最近会话：
${memoryText || '无'}

当前文章上下文：
标题：${context.title}
标签：${context.tags.join(', ') || '无'}
光标前文：${context.cursor_before}
光标后文：${context.cursor_after}
选中文本：${context.selected_text}

用户问题：
${request.query}

任务要求：
${TASK_INSTRUCTIONS[intent]}

可引用资料：
${evidence}

要求：
1. 只依据当前编辑器上下文和可引用资料处理，不得补充无法支持的事实。
2. 只有知识问答任务需要使用 [1]、[2] 引用标注；编辑改写任务不要添加引用尾注。
3. 不要大段重复输入内容，也不要解释执行过程。
4. 输出清晰、专业的中文；严格遵守该任务的返回格式。`.trim();
}
