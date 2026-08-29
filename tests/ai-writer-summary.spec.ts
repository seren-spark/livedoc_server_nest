import { jest } from '@jest/globals';
import type { AiWriteDto } from '../src/common/dto.js';
import type { AccessContext, AgentToolCall } from '../src/common/types.js';
import { AiWriterService } from '../src/ai/ai-writer.service.js';

const context: AccessContext = {
  user_id: 'user-1',
  space_id: 'space-1',
  team_ids: [],
};

const toolCall: AgentToolCall = {
  name: 'summarize_current_document',
  arguments: { query: '总结整篇文章' },
  reason: 'explicit summary',
  source: 'request_intent',
  confidence: 1,
  selection_ms: 2,
};

function summaryRequest(stream: boolean): AiWriteDto {
  return {
    intent: 'summarize_document',
    query: '总结整篇文章',
    stream,
    retrieval_domain: 'public',
    scope: { private: true, team: true, public: true, document_ids: [] },
    current_context: {
      title: '当前文章',
      cursor_before: '',
      cursor_after: '',
      selected_text: '',
      tags: [],
    },
    current_document: { title: '当前文章', content: '# 第一章\n\n完整正文' },
  } as AiWriteDto;
}

describe('AiWriterService summarize_document routing', () => {
  test('bypasses retrieval and memory for sync and SSE requests', async () => {
    const retrieval = {
      searchWithTrace: jest.fn(async () => {
        throw new Error('knowledge retrieval must not run');
      }),
      searchCurrentDocumentWithTrace: jest.fn(async () => {
        throw new Error('current-document retrieval must not run');
      }),
    };
    const memory = {
      recentText: jest.fn(async () => {
        throw new Error('conversation memory must not be read');
      }),
      add: jest.fn(async () => undefined),
    };
    const llm = {
      complete: jest.fn(async () => {
        throw new Error('generic prompt must not run');
      }),
      stream: jest.fn(),
    };
    const summary = {
      summarize: jest.fn(async () => '同步完整摘要'),
      async *stream() {
        yield { type: 'progress' as const, data: { phase: 'direct' as const, completed: 1, total: 1, level: 0 } };
        yield { type: 'progress' as const, data: { phase: 'final' as const, completed: 0, total: 1, level: 0 } };
        yield { type: 'delta' as const, data: '流式完整摘要' };
        yield { type: 'progress' as const, data: { phase: 'final' as const, completed: 1, total: 1, level: 0 } };
      },
    };
    const tools = {
      select: jest.fn(async () => toolCall),
      intentFor: jest.fn(() => 'summarize_document' as const),
    };
    const observability = {
      recordSearch: jest.fn(async () => undefined),
      recordCompletion: jest.fn(async () => undefined),
    };
    const writer = new AiWriterService(
      retrieval as never,
      memory as never,
      llm as never,
      summary as never,
      tools as never,
      observability as never,
      {} as never,
      {} as never,
    );

    const completed = await writer.complete(summaryRequest(false), context);
    expect(completed).toMatchObject({
      intent: 'summarize_document',
      answer: '同步完整摘要',
      citations: [],
      has_evidence: false,
      can_insert: true,
    });
    expect(summary.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# 第一章\n\n完整正文' }),
      undefined,
    );

    const messages = [];
    for await (const message of writer.stream(summaryRequest(true), context)) messages.push(message);
    expect(messages.slice(0, 3).map((message) => message.event))
      .toEqual(['meta', 'tool_start', 'tool_result']);
    expect(messages.filter((message) => message.event === 'meta').map((message) => message.data))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'direct', completed: 1, total: 1, level: 0 }),
        expect.objectContaining({ phase: 'final', completed: 0, total: 1, level: 0 }),
      ]));
    expect(messages.find((message) => message.event === 'delta')?.data).toBe('流式完整摘要');
    expect(messages.find((message) => message.event === 'citations')?.data)
      .toEqual(expect.objectContaining({ citations: [] }));
    expect(messages.at(-1)?.event).toBe('done');

    expect(retrieval.searchWithTrace).not.toHaveBeenCalled();
    expect(retrieval.searchCurrentDocumentWithTrace).not.toHaveBeenCalled();
    expect(memory.recentText).not.toHaveBeenCalled();
    expect(memory.add).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
