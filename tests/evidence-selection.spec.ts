import { jest } from '@jest/globals';
import { AppConfig } from '../src/config/app-config.js';
import type { AccessContext } from '../src/common/types.js';
import { ContextCompressorService } from '../src/retrieval/context-compressor.service.js';
import { selectEvidence } from '../src/retrieval/evidence-selection.js';
import { RetrievalService } from '../src/retrieval/retrieval.service.js';
import { SparseEmbeddingService } from '../src/retrieval/sparse-embedding.service.js';
import type { SearchHit } from '../src/retrieval/vector-store.service.js';

const context: AccessContext = { user_id: 'alice', space_id: 'space', team_ids: [] };
const query = 'Orion owner and rollback window';
function hit(id: string, content: string, score: number, doc = id): SearchHit {
  return { pointId: id, score, payload: {
    chunk_id: id, doc_id: doc, chunk_index: Number(id.replace(/\D/g, '')) || 0,
    title: doc, content, source_content: content, source_anchor: id, document_version: 2,
    space_id: 'space', heading_path: [], visibility: 'private',
  } };
}
function fixture() {
  return [hit('owner', 'Orion owner is Chen.', 9), hit('owner2', 'Orion owner is Chen Qing.', 8),
    hit('rollback', 'Orion rollback window is 48 hours.', 7)];
}
const ids = (hits: SearchHit[]) => hits.map((value) => value.pointId);

function harness(hits = fixture(), overrides = {}) {
  const config = Object.assign(new AppConfig(), { runtimeMode: 'test', contextTokenBudget: 64,
    contextPerCitationTokens: 32, similarityThreshold: -1, ...overrides });
  const compressor = new ContextCompressorService(config);
  const reranker = { rerank: jest.fn(async (_query: string, candidates: SearchHit[]) => candidates) };
  const catalog = { readableHits: jest.fn(async (candidates: SearchHit[]) => candidates.filter((value) =>
    value.payload.allowed !== false && value.payload.document_version === 2)) };
  const embeddings = { embedBatch: async (passages: string[]) => passages.map(() => [1, 0]),
    embed: async () => [1, 0] };
  const service = new RetrievalService(config, embeddings as any, new SparseEmbeddingService(), {} as any,
    reranker as any, compressor, { recordSearch: async () => {} } as any, undefined, catalog as any);
  jest.spyOn(service as any, 'retrieveMultiQuery').mockResolvedValue({ denseHits: hits, keywordHits: [], candidateHits: hits });
  return { service, compressor, reranker, catalog };
}
const request = { query, context: '', mode: 'hybrid' as const, top_k: 2,
  scope: { private: true, public: false, team: false, document_ids: [] } };

describe('bounded evidence facet selection', () => {
  test('fixed-candidate comparison replaces redundant evidence with the missing requested facet', () => {
    const hits = fixture();
    const original = structuredClone(hits);
    expect(ids(hits.slice(0, 2))).toEqual(['owner', 'owner2']);
    expect(ids(selectEvidence(hits, query, 2))).toEqual(['owner', 'rollback']);
    expect(hits).toEqual(original);
  });

  test('supports explicit Chinese subgoals without requiring different documents', () => {
    const hits = [hit('a', 'Orion 的负责人为陈青。', 9, 'shared'),
      hit('b', 'Orion 的负责人是陈青。', 8, 'shared'), hit('c', 'Orion 回滚窗口为48小时。', 7, 'shared')];
    expect(ids(selectEvidence(hits, '查询 Orion 的负责人和回滚窗口', 2))).toEqual(['a', 'c']);
  });

  test('keeps simple queries, already-covered rankings, top-one and short pools unchanged', () => {
    const hits = fixture();
    expect(ids(selectEvidence(hits, 'Orion owner', 2))).toEqual(['owner', 'owner2']);
    expect(ids(selectEvidence([hits[0]!, hits[2]!, hits[1]!], query, 2))).toEqual(['owner', 'rollback']);
    expect(ids(selectEvidence(hits, query, 1))).toEqual(['owner']);
    expect(ids(selectEvidence(hits.slice(0, 2), query, 2))).toEqual(['owner', 'owner2']);
    expect(selectEvidence(hits, query, 0)).toEqual([]);
  });

  test('does not promote a title-only, substring-only or partial unrelated match', () => {
    const hits = fixture().slice(0, 2);
    hits.push(hit('title-only', 'Other release notes.', 7, 'rollback window'));
    hits.push(hit('partial', 'The editor window has a new layout.', 6));
    expect(ids(selectEvidence(hits, query, 2))).toEqual(['owner', 'owner2']);
    const partial = [hit('a', 'cat facts', 9), hit('b', 'cat notes', 8), hit('c', 'category facts', 7)];
    expect(ids(selectEvidence(partial, 'cat and category', 2))).toEqual(['a', 'c']);
    expect(ids(selectEvidence(partial, 'cat and categories', 2))).toEqual(['a', 'b']);
  });

  test('keeps the first hit and never sacrifices a represented facet to add another', () => {
    const hits = [hit('a', 'alpha facts', 9), hit('b', 'beta facts', 8), hit('c', 'gamma facts', 7)];
    expect(ids(selectEvidence(hits, 'alpha and beta and gamma', 2))).toEqual(['a', 'b']);
    hits.push(hit('bc', 'beta gamma facts', 6));
    expect(ids(selectEvidence(hits, 'alpha and beta and gamma', 2))).toEqual(['a', 'bc']);
  });

  test('does not search beyond the first twenty ranked candidates', () => {
    const hits = Array.from({ length: 20 }, (_, index) => hit(`owner${index}`, 'Orion owner is Chen.', 30 - index));
    hits.push(hit('rollback', 'Orion rollback window is 48 hours.', 1));
    expect(ids(selectEvidence(hits, query, 2))).toEqual(['owner0', 'owner1']);
  });
});

describe('evidence selection through production retrieval entry points', () => {
  test('selects only authorized current evidence before preserving citation identities and compression budget', async () => {
    const hits = fixture();
    hits.unshift({ ...hit('denied', 'Orion rollback window is SECRET.', 30), payload: {
      ...hit('denied', 'Orion rollback window is SECRET.', 30).payload, allowed: false,
    } });
    hits.unshift({ ...hit('stale', 'Orion rollback window was 12 hours.', 29), payload: {
      ...hit('stale', 'Orion rollback window was 12 hours.', 29).payload, document_version: 1,
    } });
    const { service, compressor, reranker } = harness(hits, { contextTokenBudget: 24, contextPerCitationTokens: 12 });
    const result = await service.searchWithTrace({ ...request, include_retrieval_debug: true }, context);
    expect(reranker.rerank.mock.calls[0]![1].map((value) => value.pointId)).toEqual(['owner', 'owner2', 'rollback']);
    expect(result.citations.map((value) => value.chunk_id)).toEqual(['owner', 'rollback']);
    expect(result.retrieval_debug?.ranked.map((value) => value.chunk_id)).toEqual(['owner', 'rollback']);
    expect(result.retrieval_debug?.selection_strategy).toBe('facet-v1');
    expect(result.retrieval_debug?.candidates.map((value) => value.chunk_id)).toEqual(['owner', 'owner2', 'rollback']);
    expect(result.citations.map((value) => value.citation_id)).toEqual(['owner:2:owner', 'rollback:2:rollback']);
    expect(result.citations.reduce((sum, value) => sum + compressor.count(value.content), 0)).toBeLessThanOrEqual(24);
    expect(result.citations[1]!.source_content).toBe('Orion rollback window is 48 hours.');
    expect(result.trace.returned_citations).toBe(2);
  });

  test.each([true, false])('selection-off preserves direct Top-K independently of rerank=%s', async (rerank) => {
    const { service, reranker } = harness();
    const result = await service.searchWithTrace({ ...request, rerank, evidence_selection: false,
      include_retrieval_debug: true }, context);
    expect(result.citations.map((value) => value.chunk_id)).toEqual(['owner', 'owner2']);
    expect(result.retrieval_debug?.selection_strategy).toBe('rank-v1');
    expect(reranker.rerank).toHaveBeenCalledTimes(rerank ? 1 : 0);
  });

  test('selection-on can supplement fused evidence while BGE is disabled', async () => {
    const { service, reranker } = harness();
    const result = await service.searchWithTrace({ ...request, rerank: false, evidence_selection: true,
      include_retrieval_debug: true }, context);
    expect(result.citations.map((value) => value.chunk_id)).toEqual(['owner', 'rollback']);
    expect(result.retrieval_debug?.selection_strategy).toBe('facet-v1');
    expect(reranker.rerank).not.toHaveBeenCalled();
  });

  test('Wiki discovery retains distinct-page ranking and bypasses compression', async () => {
    const hits = [...fixture().slice(0, 2), hit('other-owner', 'Orion owner is Chen.', 7),
      hit('rollback', 'Orion rollback window is 48 hours.', 6)];
    hits[1]!.payload.doc_id = hits[0]!.payload.doc_id;
    const { service, compressor } = harness(hits);
    const compress = jest.spyOn(compressor, 'compress');
    const result = await service.searchWikiWithTrace(request, context, async (candidates) => candidates);
    expect(result.citations.map((value) => value.chunk_id)).toEqual(['owner', 'other-owner']);
    expect(compress).not.toHaveBeenCalled();
  });

  test('current-document selection follows the same coverage rule without persisting vectors', async () => {
    const hits = fixture();
    const { service, reranker } = harness();
    jest.spyOn(service as any, 'prepareChunksForEmbedding').mockResolvedValue({
      chunks: hits.map((value, index) => ({ chunk_id: value.pointId, content: value.payload.content,
        heading_path: [], chunk_index: index, ordinal: index,
        source_anchor: value.pointId, start_offset: 0, end_offset: value.payload.content.length })),
      passages: hits.map((value) => value.payload.content),
    });
    reranker.rerank.mockImplementation(async (_query, candidates) => hits.map((value) => ({
      ...candidates.find((candidate) => candidate.pointId === value.pointId)!, score: value.score,
    })));
    const result = await service.searchCurrentDocumentWithTrace({ query, title: 'Orion notes',
      content: 'Orion notes', topK: 2, context });
    expect(result.citations.map((value) => value.chunk_id)).toEqual(['owner', 'rollback']);
    expect(result.trace.returned_citations).toBe(2);
  });
});
