import { describe, expect, test, jest } from '@jest/globals';
import { evidenceSnapshot, promptEvidence, retrievalEvidence, sha256 } from '../src/evaluation/evidence.js';
import { chunkRankingMetrics, gradeCase, gradeRetrieval, pairedBootstrap, rankingMetrics, scoreEvidence, scoreGradedRanking, summarize, validateAssets, validateRetrievalLabels } from '../src/evaluation/rag-evaluation.js';
import { AiWriterService } from '../src/ai/ai-writer.service.js';

const citation = (doc_id: string, index: number, content: string): any => ({ doc_id, index, content,
  citation_id: `c${index}`, chunk_id: `chunk-${index}`, document_version: 1, title: doc_id, heading_path: [], source_anchor: `b${index}` });
const groups = [{ id: 'plan', alternatives: [{ doc_id: 'a', quotes: ['拆解目标'] }, { doc_id: 'b', quotes: ['拆分任务'] }] },
  { id: 'review', alternatives: [{ doc_id: 'c', quotes: ['核对来源'] }] }];

describe('frozen RAG evaluation', () => {
  test('echoing user supplied words does not prove disclosure; new facts and forbidden sources still fail', () => {
    const c = { query: 'ORCHID-19何时审计？', forbidden_facts: ['ORCHID-19', '2026年9月'], forbidden_doc_ids: ['secret'] };
    expect(gradeCase(c, null, { answer: '没有ORCHID-19审计时间的依据' })).toMatchObject({ permission_leak: false, question_echo_fact_hits: ['ORCHID-19'] });
    expect(gradeCase(c, null, { answer: 'ORCHID-19在2026年9月审计' }).permission_leak).toBe(true);
    expect(gradeCase(c, { citations: [citation('secret', 1, '内容')] }, { answer: '无法作答' }).permission_leak).toBe(true);
  });
  test('chunk ranking separates top 3, pre-rerank top 20 and evidence completeness', () => {
    const a = { ...citation('a', 1, '拆解目标'), chunk_id: 'a1' }, b = { ...citation('b', 2, '核对来源'), chunk_id: 'b1' };
    const c = { chunk_qrels: [{ chunk_id: 'a1', score: 1 }, { chunk_id: 'b1', score: 1 }],
      evidence_groups: [{ id: 'a', alternatives: [{ doc_id: 'a', quotes: ['拆解目标'] }] }, { id: 'b', alternatives: [{ doc_id: 'b', quotes: ['核对来源'] }] }] };
    const search = { retrieval_debug: { schema_version: 1, candidate_stage: 'authorized_fused_before_rerank', candidate_limit: 20,
      candidates: [a, b], ranked: [a, citation('x', 3, '无关'), citation('y', 4, '无关'), b] } };
    expect(gradeRetrieval(c, search)).toMatchObject({ recall_at_3: .5, candidate_recall_at_20: 1, mrr_at_3: 1, evidence_at_3: { all: false, recall: .5 } });
    expect(gradeRetrieval({ ...c, chunk_qrels: [], evidence_groups: [] }, search).recall_at_3).toBeNull();
    expect(() => gradeRetrieval(c, { citations: [a, b] })).toThrow('候选池');
    expect(chunkRankingMetrics([{ chunk_id: 'a', score: 3 }, { chunk_id: 'b', score: 1 }], ['b', 'a'], 3).ndcg).toBeLessThan(1);
    expect(chunkRankingMetrics([{ chunk_id: 'a', score: 1 }], ['a', 'a'], 3).ndcg).toBe(1);
    expect(gradeCase({ forbidden_doc_ids: ['b'] }, search, null).permission_leak).toBe(true);
  });
  test('fixed retrieval labels cover every positive and distinguish annotated negative cases', () => {
    const corpus = [{ doc_id: 'a', content: '原文' }];
    const c = { case_id: 'q', annotation_version: 'v1', chunk_qrels: [{ chunk_id: 'a1', score: 1 }], relevant_doc_ids: ['a'],
      evidence_groups: [{ id: 'g', alternatives: [{ doc_id: 'a', quotes: ['原文'] }] }] };
    const manifest = { chunks: [{ chunk_id: 'a1', doc_id: 'a', content: '原文', start_offset: 0, end_offset: 2 }] };
    expect(() => validateRetrievalLabels(corpus, [c], manifest)).not.toThrow();
    expect(() => validateRetrievalLabels(corpus, [{ ...c, chunk_qrels: [] }], manifest)).toThrow('正例');
    expect(() => validateRetrievalLabels(corpus, [{ ...c, chunk_qrels: [{ chunk_id: 'unknown', score: 1 }] }], manifest)).toThrow('无效');
    expect(() => validateRetrievalLabels(corpus, [{ ...c, relevant_doc_ids: [], chunk_qrels: [], evidence_groups: [], expected_behavior: 'abstain' }], manifest)).not.toThrow();
    const splitCorpus = [{ doc_id: 'a', content: '第一条。第二条。' }];
    const splitManifest = { chunks: [{ chunk_id: 'a1', doc_id: 'a', content: '第一条。', start_offset: 0, end_offset: 4 },
      { chunk_id: 'a2', doc_id: 'a', content: '第二条。', start_offset: 4, end_offset: 8 }] };
    const splitCase = { ...c, chunk_qrels: [{ chunk_id: 'a1', score: 1 }, { chunk_id: 'a2', score: 1 }],
      evidence_groups: [{ id: 'g', alternatives: [{ doc_id: 'a', quotes: ['第一条', '第二条'] }] }] };
    expect(() => validateRetrievalLabels(splitCorpus, [splitCase], splitManifest)).not.toThrow();
    expect(() => validateRetrievalLabels(splitCorpus, [{ ...splitCase, chunk_qrels: splitCase.chunk_qrels.slice(0, 1) }], splitManifest)).toThrow('必要证据');
  });
  test('all evidence groups are required; equivalent sources within one group are alternatives', () => {
    expect(scoreEvidence(groups, [citation('b', 1, '拆分任务'), citation('c', 2, '核对来源')], true).all).toBe(true);
    expect(scoreEvidence(groups, [citation('a', 1, '无关内容'), citation('c', 2, '核对来源')]).all).toBe(true);
    expect(scoreEvidence(groups, [citation('a', 1, '无关内容'), citation('c', 2, '核对来源')], true).recall).toBe(.5);
    expect(scoreEvidence([], []).recall).toBeNull();
  });
  test('duplicates cannot inflate NDCG and ranks outside k do not count', () => {
    expect(rankingMetrics(['a', 'b'], ['a', 'a'], 2).ndcg).toBeLessThan(1);
    expect(rankingMetrics(['b'], ['a', 'b'], 1)).toEqual({ recall: 0, mrr: 0, ndcg: 0 });
    expect(rankingMetrics([], ['a'], 2).recall).toBeNull();
  });
  test('validates labels against frozen original text and rejects duplicate questions', () => {
    const corpus = [{ doc_id: 'a', owner_email: 'owner', content: '原文', sha256: sha256('原文') }];
    const c = { case_id: 'q1', identity: 'owner', query: '问题', scope: {}, evidence_groups: [{ id: 'g', alternatives: [{ doc_id: 'a', quotes: ['原文'] }] }] };
    expect(() => validateAssets(corpus, [c])).not.toThrow();
    expect(() => validateAssets(corpus, [c, c])).toThrow('重复');
    c.evidence_groups[0]!.alternatives[0]!.quotes = ['不存在的答案'];
    expect(() => validateAssets(corpus, [c])).toThrow('冻结原文');
  });
  test('citation indexes are not renumbered and word matches do not establish correctness', () => {
    const c = { relevant_doc_ids: ['a'], required_facts: [['规划'], ['执行']] };
    const a = citation('a', 5, '规划拆解，执行调用');
    const grade = gradeCase(c, { citations: [a] }, { answer: '规划调用，执行拆解 [5]', citations: [a] });
    expect(grade.citation_validity).toBe(1);
    expect(grade.fact_pattern_coverage).toBe(1);
    expect(grade.correctness).toBeNull();
    expect(grade.requires_human_review).toBe(true);
    expect(grade.injected_sources).toBeNull();
  });
  test('a different search cannot impersonate the actual prompt; mismatched hashes are unavailable', () => {
    const c = { evidence_groups: [groups[0]], relevant_doc_ids: ['a'] };
    const actual = citation('a', 1, '缺少所需句子');
    const answer = { answer: '内容 [1]', citations: [actual], trace: { trace_id: 't' }, evidence_snapshot: evidenceSnapshot('t', 'prompt', [actual], true) };
    const grade = gradeCase(c, { citations: [citation('a', 1, '拆解目标')] }, answer);
    expect(grade.retrieval_quotes?.all).toBe(true);
    expect(grade.injected_quotes?.all).toBe(false);
    answer.evidence_snapshot.evidence_sha256 = 'invalid';
    expect(gradeCase(c, null, answer).context_paired).toBe(false);
  });
  test('failures and unlabelled cases never turn into invented zero or perfect answer scores', () => {
    const c = { relevant_doc_ids: ['a'], search: { citations: [citation('a', 1, 'text')] }, answer: null, error: 'model failed' };
    const result = summarize([{ ...c, grade: gradeCase(c, c.search, null), search_latency_ms: 12 }], 5);
    expect(result.recall_at_k).toBe(1);
    expect(result.generation_success_rate).toBe(0);
    expect(result.citation_validity).toBeNull();
    expect(result.answer_correctness).toBeNull();
    expect(result.answer_p50_ms).toBeNull();
  });
  test('paired bootstrap is reproducible and handles empty pairs', () => {
    expect(pairedBootstrap([.2, .2, .2])).toMatchObject({ delta: expect.closeTo(.2), ci95: [expect.closeTo(.2), expect.closeTo(.2)], questions: 3 });
    expect(pairedBootstrap([-.2, .3])).toEqual(pairedBootstrap([-.2, .3]));
    expect(pairedBootstrap([]).ci95).toBeNull();
  });
  test('graded rerank scores distinguish partial support and require a complete permutation', () => {
    const items = [{ id: 'full', relevance: 2 }, { id: 'part', relevance: 1 }, { id: 'none', relevance: 0 }];
    expect(scoreGradedRanking(items, ['full', 'part', 'none'], 3).ndcg).toBe(1);
    expect(scoreGradedRanking(items, ['part', 'none', 'full'], 3).ndcg).toBeLessThan(1);
    expect(() => scoreGradedRanking(items, ['full', 'full', 'none'], 3)).toThrow('完整排列');
  });
  test('writer snapshots all actual inputs, retains only cited sources in the answer and respects document scope', async () => {
    const citations = [citation('a', 2, '先规划'), citation('b', 5, '再执行')];
    const debug = { schema_version: 1 as const, candidate_stage: 'authorized_fused_before_rerank' as const, candidate_limit: 20 as const,
      candidates: citations, ranked: citations };
    const search = jest.fn(async (_request: any) => ({ citations, trace: { trace_id: 'real-turn' }, retrieval_debug: debug }));
    const complete = jest.fn(async (prompt: string) => {
      expect(prompt).toContain(JSON.stringify(promptEvidence(citations)));
      return '执行结果 [5]';
    });
    const writer = new AiWriterService({ searchWithTrace: search } as any,
      { recentText: async () => '' } as any, { complete } as any, {} as any,
      { select: async () => ({ name: 'search_knowledge_base', arguments: { query: 'query', retrieval_domain: 'public' } }), intentFor: () => 'knowledge_qa' } as any,
      { recordCompletion: async () => undefined } as any, {} as any, { promptText: async () => '' } as any);
    const response = await writer.complete({ query: 'query', include_evidence: true, current_context: { title: '', tags: [], cursor_before: '', cursor_after: '', selected_text: '' },
      scope: { document_ids: ['a', 'b'] } } as any, { user_id: 'u', space_id: 's', team_ids: [] });
    expect(search.mock.calls[0]![0].scope).toMatchObject({ document_ids: ['a', 'b'], public: true, private: false });
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]!.index).toBe(5);
    expect(response.evidence_snapshot?.citations).toHaveLength(2);
    expect(response.evidence_snapshot?.prompt_sha256).toBe(sha256(complete.mock.calls[0]![0]));
    expect(search.mock.calls[0]![0].include_retrieval_debug).toBe(true);
    expect(response.evidence_snapshot?.retrieval_debug).toEqual(debug);
    expect(response.evidence_snapshot?.retrieval_debug_sha256).toBe(sha256(JSON.stringify(retrievalEvidence(debug))));
  });
});
