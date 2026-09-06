import {
  AGENT_TOOL_DEFINITIONS,
  createLlmTool,
  LlmToolName,
} from '../src/ai/llm-tools.js';

describe('LLM tool definitions', () => {
  test('registers agent tools by their enum-like names', () => {
    expect(AGENT_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual([
      LlmToolName.SearchKnowledgeBase,
      LlmToolName.SummarizeCurrentDocument,
      LlmToolName.ContinueParagraph,
      LlmToolName.OptimizeFormat,
    ]);
  });

  test('builds runtime-dependent schemas through the tool registry', () => {
    const expand = createLlmTool[LlmToolName.ExpandSearchQueries](2);
    expect(expand.function.name).toBe(LlmToolName.ExpandSearchQueries);
    expect(expand.function.parameters).toMatchObject({
      properties: { queries: { maxItems: 2 } },
    });

    const memory = createLlmTool[LlmToolName.RecordDocumentMemory](['hash-1']);
    expect(memory.function.name).toBe(LlmToolName.RecordDocumentMemory);
    expect(memory.function.parameters).toMatchObject({
      properties: {
        glossary: {
          items: {
            properties: {
              evidence_hashes: { items: { enum: ['hash-1'] } },
            },
          },
        },
      },
    });
  });
});
