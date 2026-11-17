/**
 * @file 模型结构化工具。定义查询扩展和文档记忆提取所使用的工具名称与参数协议。
 */
import type { AgentToolCall } from '../common/types.js';

export const LlmToolName = {
  SearchKnowledgeBase: 'search_knowledge_base',
  SummarizeCurrentDocument: 'summarize_current_document',
  ContinueParagraph: 'continue_paragraph',
  OptimizeFormat: 'optimize_format',
  ExpandSearchQueries: 'expand_search_queries',
  RecordDocumentMemory: 'record_document_memory',
} as const;

export type LlmToolName = (typeof LlmToolName)[keyof typeof LlmToolName];
export type AgentToolName = AgentToolCall['name'];

export interface LlmFunctionTool {
  type: 'function';
  function: {
    name: LlmToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const AGENT_TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  [LlmToolName.SearchKnowledgeBase]: '检索有权限访问的知识库并生成带来源引用的回答。',
  [LlmToolName.SummarizeCurrentDocument]: '仅依据当前文档内容生成摘要，不引入外部事实。',
  [LlmToolName.ContinueParagraph]: '根据光标上下文续写当前段落，必要时检索知识库。',
  [LlmToolName.OptimizeFormat]: '优化选中文本的结构与表达，保留原意和事实。',
};

export const AGENT_TOOL_DEFINITIONS: LlmFunctionTool[] = (
  Object.keys(AGENT_TOOL_DESCRIPTIONS) as AgentToolName[]
).map((name) => {
  const retrieves =
    name === LlmToolName.SearchKnowledgeBase ||
    name === LlmToolName.ContinueParagraph;
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
      description: AGENT_TOOL_DESCRIPTIONS[name],
      parameters: {
        type: 'object',
        properties,
        required: retrieves
          ? ['query', 'retrieval_domain', 'confidence', 'reason']
          : ['query', 'confidence', 'reason'],
      },
    },
  };
});

export const createLlmTool = {
  /**
   * 定义查询扩展工具的参数结构，约束模型返回可用于检索的查询。
   *
   * @param maxVariants maxVariants 对应的数量或范围限制。
   * @returns LlmFunctionTool 类型的处理结果。
   */
  [LlmToolName.ExpandSearchQueries](maxVariants: number): LlmFunctionTool {
    return {
      type: 'function',
      function: {
        name: LlmToolName.ExpandSearchQueries,
        description: '生成保持原意的检索查询变体。',
        parameters: {
          type: 'object',
          properties: {
            queries: {
              type: 'array',
              items: { type: 'string' },
              maxItems: maxVariants,
            },
          },
          required: ['queries'],
        },
      },
    };
  },

  /**
   * 定义文档记忆记录工具的参数结构，约束提取项及其来源。
   *
   * @param hashes 用于匹配和去重的内容摘要集合。
   * @returns LlmFunctionTool 类型的处理结果。
   */
  [LlmToolName.RecordDocumentMemory](hashes: string[]): LlmFunctionTool {
    const confidence = { type: 'number', minimum: 0, maximum: 1 };
    const evidenceHashes = {
      type: 'array',
      items: { type: 'string', enum: hashes },
      maxItems: 3,
    };
    return {
      type: 'function',
      function: {
        name: LlmToolName.RecordDocumentMemory,
        description: '从文档证据中提取可长期复用的结构化记忆。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            glossary: {
              type: 'array',
              maxItems: 30,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  term: { type: 'string' },
                  definition: { type: 'string' },
                  aliases: {
                    type: 'array',
                    items: { type: 'string' },
                    maxItems: 10,
                  },
                  evidence_hashes: evidenceHashes,
                  confidence,
                },
                required: [
                  'term',
                  'definition',
                  'aliases',
                  'evidence_hashes',
                  'confidence',
                ],
              },
            },
            style_tags: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string' },
                  instruction: { type: 'string' },
                  evidence_hashes: evidenceHashes,
                  confidence,
                },
                required: [
                  'label',
                  'instruction',
                  'evidence_hashes',
                  'confidence',
                ],
              },
            },
            global_settings: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string' },
                  value: { type: 'string' },
                  evidence_hashes: evidenceHashes,
                  confidence,
                },
                required: [
                  'key',
                  'value',
                  'evidence_hashes',
                  'confidence',
                ],
              },
            },
          },
          //这三个数组必须都返回
          required: ['glossary', 'style_tags', 'global_settings'],
        },
      },
    };
  },
};
