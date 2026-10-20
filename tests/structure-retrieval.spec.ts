import { jest } from '@jest/globals';
import { AppConfig } from '../src/config/app-config.js';
import type { AccessContext, Citation } from '../src/common/types.js';
import type { DocumentIndexRequest } from '../src/documents/document.types.js';
import { EmbeddingService } from '../src/inference/embedding.service.js';
import type { InferenceWorkerService } from '../src/inference/inference-worker.service.js';
import { RerankerService } from '../src/inference/reranker.service.js';
import type { ObservabilityService } from '../src/observability/observability.service.js';
import { ContextCompressorService } from '../src/retrieval/context-compressor.service.js';
import { RetrievalService } from '../src/retrieval/retrieval.service.js';
import { SparseEmbeddingService } from '../src/retrieval/sparse-embedding.service.js';
import { VectorStoreService } from '../src/retrieval/vector-store.service.js';
import { parseMarkdown } from '../src/retrieval/markdown-structure.js';

const context: AccessContext = { user_id: 'alice', space_id: 'space', team_ids: [] };
const table = '| 参数 | 类型 | 说明 |\n| --- | --- | --- |\n' + Array.from({ length: 30 }, (_, index) =>
  `| setting${index} | number | 第 ${index} 个参数的请求配置 |`).join('\n');

function createServices(overrides: Record<string, unknown> = {}) {
  const config = Object.assign(new AppConfig(), {
    runtimeMode: 'test', embeddingProvider: 'hash', embeddingDim: 32,
    vectorStore: 'memory', sparseEmbeddingProvider: 'memory_bm25', rerankProvider: 'none',
    similarityThreshold: -1, chunkMaxTokens: 128, chunkOverlapTokens: 16,
    contextTokenBudget: 4096, contextPerCitationTokens: 192, ...overrides,
  });
  const worker = {} as InferenceWorkerService;
  const embeddings = new EmbeddingService(config, worker);
  const sparse = new SparseEmbeddingService();
  const store = new VectorStoreService(config, sparse);
  const compressor = new ContextCompressorService(config);
  const observability = { recordSearch: jest.fn(async () => undefined) } as unknown as ObservabilityService;
  const retrieval = new RetrievalService(config, embeddings, sparse, store,
    new RerankerService(config, worker), compressor, observability);
  return { config, embeddings, store, compressor, retrieval };
}

describe('structure-aware retrieval and compression', () => {
  test('diagnostics capture actual pre-rerank candidates, require opt-in and preserve default ranking', async () => {
    const { retrieval, config } = createServices({ rerankProvider: 'bge' });
    const hits = ['first', 'second'].map((id, i) => ({ pointId: id, score: 1 / (i + 1), payload: {
      chunk_id: id, doc_id: id, chunk_index: 0, title: id, content: id, source_content: id, document_version: 1, heading_path: [],
    } }));
    jest.spyOn(retrieval as any, 'retrieveMultiQuery').mockResolvedValue({ denseHits: hits, keywordHits: [], candidateHits: hits });
    const rerank = jest.spyOn((retrieval as any).reranker, 'rerank').mockResolvedValue([{ ...hits[1], score: 2 }, { ...hits[0], score: 1 }]);
    const request: any = { query: 'q', context: '', mode: 'dense', top_k: 3, scope: {} };
    expect((await retrieval.searchWithTrace(request, context)).retrieval_debug).toBeUndefined();
    const result = await retrieval.searchWithTrace({ ...request, include_retrieval_debug: true }, context);
    expect(result.retrieval_debug?.candidates.map(c => c.chunk_id)).toEqual(['first', 'second']);
    expect(result.retrieval_debug?.ranked.map(c => c.chunk_id)).toEqual(['second', 'first']);
    rerank.mockClear();
    const original = await retrieval.searchWithTrace({ ...request, include_retrieval_debug: true, rerank: false }, context);
    expect(rerank).not.toHaveBeenCalled();
    expect(original.trace.reranked_candidates).toBe(0);
    expect(original.retrieval_debug?.ranked.map(c => c.chunk_id)).toEqual(['first', 'second']);
  });
  test('indexes enriched passages, preserves source payloads, and returns table headers after compression', async () => {
    const { retrieval, store, embeddings } = createServices();
    const embed = jest.spyOn(embeddings, 'embedBatch');
    const document: DocumentIndexRequest = {
      doc_id: 'settings', space_id: 'space', team_id: null, owner_id: 'alice',
      title: '请求配置', content: table, visibility: 'private', source_type: 'note',
      tags: [], url: null, document_version: 1, document_updated_at: '2026-10-13T00:00:00.000Z',
    };
    await retrieval.indexDocument(document);
    const passages = embed.mock.calls[0]![0];
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((text) => text.includes('| 参数 | 类型 | 说明 |'))).toBe(true);
    for (const { payload } of store.points.values()) {
      expect(table.slice(payload.start_offset, payload.end_offset)).toBe(payload.source_content);
      expect(payload.content).toContain('| 参数 | 类型 | 说明 |');
    }
    const { citations } = await retrieval.searchWithTrace({
      query: 'setting29', top_k: 1, mode: 'keyword', context: '',
      scope: { private: true, team: false, public: false, document_ids: [] },
    }, context);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.content).toContain('setting29');
    expect(citations[0]!.content).toContain('| 参数 | 类型 | 说明 |');
    expect(table.slice(citations[0]!.start_offset!, citations[0]!.end_offset!)).toBe(citations[0]!.source_content);
  });

  test('current-document retrieval uses the same enriched content and original offsets', async () => {
    const { retrieval } = createServices();
    const { citations } = await retrieval.searchCurrentDocumentWithTrace({
      query: 'setting29', title: '请求配置', content: table, topK: 1, context,
    });
    expect(citations).toHaveLength(1);
    expect(citations[0]!.content).toContain('| 参数 | 类型 | 说明 |');
    expect(table.slice(citations[0]!.start_offset!, citations[0]!.end_offset!)).toBe(citations[0]!.source_content);
  });

  test('compresses tables by complete rows with repeated headers under the generation token budget', () => {
    const { compressor } = createServices();
    const compressed = compressor.extractRelevant(table, 'setting29', 96);
    expect(compressed).toContain('setting29');
    expect(compressed).toContain('| 参数 | 类型 | 说明 |');
    expect(compressor.count(compressed)).toBeLessThanOrEqual(96);
    const parsed = parseMarkdown(compressed);
    expect(parsed.children!.some((node) => node.type === 'table')).toBe(true);
  });

  test('compresses code at boundaries and keeps language, fences and function ownership', () => {
    const { compressor } = createServices();
    const code = '```ts\nfunction calculate(input: number) {\n' + Array.from({ length: 30 }, (_, index) =>
      `  const value${index} = input + ${index};`).join('\n') + '\n  return value29;\n}\n```';
    const compressed = compressor.extractRelevant(code, 'value29', 128);
    expect(compressed).toContain('value29');
    expect(compressed).toContain('```ts');
    expect(compressed).toContain('所属函数：calculate');
    expect(parseMarkdown(compressed).children!.some((node) => node.type === 'code')).toBe(true);
    expect(compressor.count(compressed)).toBeLessThanOrEqual(128);
  });

  test('preserves indentation, checkboxes and parent labels when compressing nested lists', () => {
    const { compressor } = createServices();
    const list = '2. 配置数据库\n' + Array.from({ length: 20 }, (_, index) =>
      `   - [x] 检查连接子步骤 ${index}`).join('\n');
    const compressed = compressor.extractRelevant(list, '子步骤 19', 96);
    expect(compressed).toContain('配置数据库');
    expect(compressed).toContain('- [x]');
    expect(compressor.count(compressed)).toBeLessThanOrEqual(96);
  });

  test('preserves complete formulas and drops indivisible formulas when the budget cannot contain them', () => {
    const { compressor } = createServices();
    const formula = '$$\n\\frac{a}{b} + x = y\n$$';
    const content = `以下计算目标值。\n\n${formula}\n\n其中 a 和 b 为输入。`;
    expect(compressor.extractRelevant(content, '目标值 a b', 96)).toContain(formula);
    expect(compressor.extractRelevant(formula, 'a', 3)).toBe('');
    expect(compressor.extractRelevant('$x + y + z$', 'x', 2)).toBe('');
  });

  test('does not slice reference definitions or inline atoms during compression', () => {
    const { compressor } = createServices();
    const content = `${'背景说明。'.repeat(30)}\n\n请查阅 [接口配置][api]。\n\n[api]: https://example.com/api`;
    const compressed = compressor.extractRelevant(content, '接口配置', 64);
    expect(compressed).toContain('[接口配置][api]');
    expect(compressed).toContain('[api]: https://example.com/api');
    expect(compressor.count(compressed)).toBeLessThanOrEqual(64);
  });

  test('keeps raw source evidence and counts actual separators against the total context budget', () => {
    const { compressor } = createServices({ contextTokenBudget: 100, contextPerCitationTokens: 64 });
    const citations = [1, 2].map((index) => ({
      content: table, source_content: `raw source ${index}`, index,
    })) as Citation[];
    const compressed = compressor.compress(citations, 'setting29');
    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed[0]!.source_content).toBe('raw source 1');
    expect(compressed.reduce((total, item) => total + compressor.count(item.content), 0)).toBeLessThanOrEqual(100);
  });
});
