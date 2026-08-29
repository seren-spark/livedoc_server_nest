import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AppConfig } from '../src/config/app-config.js';
import { DocumentSummaryService } from '../src/ai/document-summary.service.js';
import type { LlmService } from '../src/ai/llm.service.js';
import { ContextCompressorService } from '../src/retrieval/context-compressor.service.js';

type CompleteHandler = (
  prompt: string,
  signal?: AbortSignal,
  maxOutputTokens?: number,
) => Promise<string>;

class FakeLlm {
  readonly completeCalls: Array<{ prompt: string; signal?: AbortSignal; maxOutputTokens?: number }> = [];
  readonly streamCalls: Array<{ prompt: string; signal?: AbortSignal; maxOutputTokens?: number }> = [];
  completeHandler: CompleteHandler = async () => '最终摘要';
  streamDeltas = ['最终', '摘要'];

  async complete(prompt: string, signal?: AbortSignal, maxOutputTokens?: number): Promise<string> {
    this.completeCalls.push({ prompt, signal, maxOutputTokens });
    return this.completeHandler(prompt, signal, maxOutputTokens);
  }

  async *stream(
    prompt: string,
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): AsyncGenerator<string> {
    this.streamCalls.push({ prompt, signal, maxOutputTokens });
    for (const delta of this.streamDeltas) yield delta;
  }
}

function createService(
  overrides: Record<string, unknown> = {},
  fake = new FakeLlm(),
): { service: DocumentSummaryService; fake: FakeLlm } {
  const config = Object.assign(new AppConfig(), {
    llmContextWindow: 8192,
    summaryMaxOutputTokens: 512,
    summarySafetyRatio: 0.15,
    summaryMapInputTokens: 512,
    ...overrides,
  });
  return {
    service: new DocumentSummaryService(
      config,
      fake as unknown as LlmService,
      new ContextCompressorService(config),
    ),
    fake,
  };
}

describe('DocumentSummaryService', () => {
  test('summarizes a roughly 1000-token document directly without truncating its tail', async () => {
    const { service, fake } = createService();
    const tail = '文章末尾唯一标记-END';
    const content = `${'知识'.repeat(1000)}${tail}`;

    await expect(service.summarize({ title: '短文', content })).resolves.toBe('最终摘要');

    expect(fake.completeCalls).toHaveLength(1);
    expect(fake.completeCalls[0]?.prompt).toContain(content);
    expect(fake.completeCalls[0]?.prompt).toContain(tail);
    expect(fake.completeCalls[0]?.maxOutputTokens).toBe(512);
  });

  test('maps every Markdown section in order with zero overlap and streams final progress', async () => {
    const { service, fake } = createService({
      llmContextWindow: 2048,
      summaryMaxOutputTokens: 256,
      summaryMapInputTokens: 256,
    });
    fake.completeHandler = async (prompt) => {
      const marker = prompt.match(/BODY-[A-Z]/u)?.[0] ?? 'continuation';
      return `### 章节主题\n${marker}\n### 核心要点\n要点\n### 结论\n结论\n### 示例\n未提及\n### 注意事项\n未提及`;
    };
    const content = ['A', 'B', 'C', 'D']
      .map((name) => `# 章节 ${name}\n\nBODY-${name} ${'内容'.repeat(500)}`)
      .join('\n\n');

    const events = [];
    for await (const event of service.stream({ title: '长文', content })) events.push(event);

    const mapPrompts = fake.completeCalls
      .map((call) => call.prompt)
      .filter((prompt) => prompt.includes('文章分段总结助手'));
    const allMapInput = mapPrompts.join('\n');
    expect(mapPrompts.length).toBeGreaterThan(1);
    expect(['A', 'B', 'C', 'D'].map((name) => allMapInput.indexOf(`BODY-${name}`)))
      .toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(allMapInput.indexOf('BODY-A')).toBeLessThan(allMapInput.indexOf('BODY-B'));
    expect(allMapInput.indexOf('BODY-B')).toBeLessThan(allMapInput.indexOf('BODY-C'));
    for (const name of ['A', 'B', 'C', 'D']) {
      expect(allMapInput.match(new RegExp(`BODY-${name}`, 'gu'))).toHaveLength(1);
    }
    expect(events.filter((event) => event.type === 'progress').map((event) => event.data.phase))
      .toEqual(expect.arrayContaining(['map', 'final']));
    expect(events.filter((event) => event.type === 'delta').map((event) => event.data).join(''))
      .toBe('最终摘要');
    expect(fake.streamCalls[0]?.maxOutputTokens).toBe(256);
  });

  test('recursively reduces oversized partial summaries and retries a failed group once', async () => {
    const { service, fake } = createService({
      llmContextWindow: 2048,
      summaryMaxOutputTokens: 256,
      summaryMapInputTokens: 900,
    });
    let failedOnce = false;
    fake.completeHandler = async (prompt) => {
      if (prompt.includes('文章分段总结助手')) return `章节摘要-${'summary '.repeat(300)}`;
      if (prompt.includes('分层摘要归并助手')) {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error('temporary failure');
        }
        return `归并摘要-${'merged '.repeat(50)}`;
      }
      return '最终摘要';
    };
    const content = Array.from(
      { length: 8 },
      (_, index) => `# Section ${index + 1}\n\nUNIQUE-${index + 1} ${'body '.repeat(240)}`,
    ).join('\n\n');

    await expect(service.summarize({ title: '超长文', content })).resolves.toBe('最终摘要');

    const reduceCalls = fake.completeCalls.filter((call) => call.prompt.includes('分层摘要归并助手'));
    expect(reduceCalls.length).toBeGreaterThan(1);
    expect(reduceCalls[0]?.prompt).toBe(reduceCalls[1]?.prompt);
    expect(fake.completeCalls.at(-1)?.maxOutputTokens).toBe(256);
  });

  test('fails the whole summary after a group fails twice', async () => {
    const { service, fake } = createService({
      llmContextWindow: 2048,
      summaryMaxOutputTokens: 256,
      summaryMapInputTokens: 256,
    });
    fake.completeHandler = async () => {
      throw new Error('model unavailable');
    };

    await expect(
      service.summarize({ content: `# Long document\n\n${'content '.repeat(2000)}` }),
    ).rejects.toThrow('after one retry');
    expect(fake.completeCalls).toHaveLength(2);
  });

  test('does not start another model call after cancellation', async () => {
    const { service, fake } = createService({
      llmContextWindow: 2048,
      summaryMaxOutputTokens: 256,
      summaryMapInputTokens: 256,
    });
    const abort = new AbortController();
    abort.abort();

    await expect(
      service.summarize({ content: `# Long document\n\n${'content '.repeat(2000)}` }, abort.signal),
    ).rejects.toThrow();
    expect(fake.completeCalls).toHaveLength(0);
  });

  test('rejects an empty current document explicitly', async () => {
    const { service } = createService();
    await expect(service.summarize({ content: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
