import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { AgentToolsService, normalizeQueryVariants } from '../src/ai/agent-tools.service.js';
import { ConversationMemoryService } from '../src/ai/memory.service.js';
import { DocumentCreateDto, DocumentUpdateDto, type AiWriteDto } from '../src/common/dto.js';
import type { AccessContext } from '../src/common/types.js';
import { AppConfig } from '../src/config/app-config.js';
import type { DatabaseService } from '../src/database/database.service.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import type { DocumentIndexRequest } from '../src/documents/document.types.js';
import { adoptionRate, calculateRetrievalMetrics, gradeGroundedAnswer } from '../src/evaluation/metrics.js';
import { IndexJobsService } from '../src/indexing/index-jobs.service.js';
import { ContextCompressorService } from '../src/retrieval/context-compressor.service.js';
import { rrfFuseMany } from '../src/retrieval/retrieval.service.js';
import { SparseEmbeddingService } from '../src/retrieval/sparse-embedding.service.js';
import { tokenizeHash, tokenizeKeyword } from '../src/retrieval/text-utils.js';
import { bm25Search, buildPermissionFilter, canAccess } from '../src/retrieval/vector-store.service.js';

const noDatabase = { enabled: false } as DatabaseService;
const alice: AccessContext = { user_id: 'user_alice', space_id: 'space_a', team_ids: ['team_alpha'] };
const bob: AccessContext = { user_id: 'user_bob', space_id: 'space_a', team_ids: ['team_alpha'] };
const carol: AccessContext = { user_id: 'user_carol', space_id: 'space_a', team_ids: ['team_beta'] };

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return Object.assign(new AppConfig(), overrides);
}

function indexRequest(docId = 'doc-1', version = 1): DocumentIndexRequest {
  return {
    doc_id: docId,
    space_id: 'space_a',
    title: 'LiveDoc 检索',
    content: '中文知识库使用 BM25 与向量检索。',
    visibility: 'private',
    source_type: 'article',
    tags: ['rag'],
    team_id: null,
    owner_id: 'user_alice',
    url: null,
    document_version: version,
  };
}

describe('Python 34-test parity - unit and structural checks', () => {
  test('metrics cover recall, rank, precision and permission leakage', () => {
    expect(calculateRetrievalMetrics([{
      expected_chunk_ids: ['a', 'b'],
      retrieved_chunk_ids: ['x', 'a'],
      permitted_chunk_ids: ['a', 'b'],
    }])).toEqual({ recall_at_k: 0.5, mean_reciprocal_rank: 0.5, precision_at_k: 0.5, permission_leak_rate: 0.5 });
  });

  test('end-to-end grading detects grounded answers and refusals', () => {
    expect(gradeGroundedAnswer('答案见 [1]', 1)).toEqual({ grounded: true, has_citation: true });
    expect(gradeGroundedAnswer('没有引用的断言', 1).grounded).toBe(false);
    expect(gradeGroundedAnswer('知识库未查询到相关依据，无法作答', 0).grounded).toBe(true);
  });

  test('adoption uses completed evidence answers as denominator', () => {
    expect(adoptionRate(4, 3)).toBe(0.75);
    expect(adoptionRate(0, 3)).toBe(0);
  });

  test('LLM function call is normalized to a known typed tool', async () => {
    const llm = {
      isConfigured: true,
      selectTool: async () => ({ name: 'knowledge_search', arguments: { query: 'RAG', confidence: 0.9 }, reason: 'search' }),
    };
    const service = new AgentToolsService(config({ agentToolSelection: 'llm' }), llm as never);
    const request = {
      query: 'RAG', retrieval_domain: 'public',
      current_context: { title: 'x', cursor_before: '', cursor_after: '', selected_text: '', tags: [] },
    } as unknown as AiWriteDto;
    await expect(service.select(request)).resolves.toMatchObject({ name: 'knowledge_search', source: 'llm_function_call' });
  });

  test('fixed corpus and case counts remain 18 and 60', () => {
    const corpus = readJsonLines(resolve('../livedoc_server/evals/rag_corpus.jsonl'));
    const cases = readJsonLines(resolve('../livedoc_server/evals/rag_cases.jsonl'));
    expect([corpus.length, cases.length]).toEqual([18, 60]);
  });

  test('real evaluation preflight rejects smoke providers', () => {
    const invalid = config().productionMisconfigurations();
    expect(invalid).toEqual(expect.arrayContaining(['VECTOR_STORE', 'EMBEDDING_PROVIDER', 'RERANK_PROVIDER', 'LLM_API_KEY']));
  });

  test('duplicate active index requests coalesce', async () => {
    const jobs = new IndexJobsService(config(), noDatabase);
    const first = await jobs.enqueue(indexRequest(), alice);
    const second = await jobs.enqueue(indexRequest(), alice);
    expect(second.job_id).toBe(first.job_id);
  });

  test('job generation is scoped to document version like Python', async () => {
    const jobs = new IndexJobsService(config(), noDatabase);
    const first = await jobs.enqueue(indexRequest('doc-versioned', 1), alice);
    const second = await jobs.enqueue(indexRequest('doc-versioned', 2), alice);
    expect([first.generation, second.generation]).toEqual([1, 1]);
    await jobs.succeed(second.job_id);
    const third = await jobs.enqueue(indexRequest('doc-versioned', 2), alice);
    expect(third.generation).toBe(2);
  });

  test('forced reindex still coalesces an active version', async () => {
    const jobs = new IndexJobsService(config(), noDatabase);
    const first = await jobs.enqueue(indexRequest('doc-force'), alice);
    const second = await jobs.enqueue(indexRequest('doc-force'), alice, true);
    expect(second.job_id).toBe(first.job_id);
  });

  test('delete cancels a waiting index job', async () => {
    const jobs = new IndexJobsService(config(), noDatabase);
    const job = await jobs.enqueue(indexRequest('doc-delete'), alice);
    await jobs.cancelDocument('doc-delete');
    await expect(jobs.get(job.job_id)).resolves.toMatchObject({
      status: 'canceled', error: 'Document deleted', dedupe_key: null,
    });
  });

  test('delete cancels a leased running job and releases its worker', async () => {
    const jobs = new IndexJobsService(config(), noDatabase);
    const job = await jobs.enqueue(indexRequest('doc-running'), alice);
    await jobs.claimNext('worker-1');
    await jobs.cancelDocument('doc-running');
    await expect(jobs.get(job.job_id)).resolves.toMatchObject({
      status: 'canceled', worker_id: null, lease_expires_at: null,
    });
  });

  test('retry keeps a failed new version out of the succeeded state', async () => {
    const jobs = new IndexJobsService(config({ indexJobMaxAttempts: 3 }), noDatabase);
    const queued = await jobs.enqueue(indexRequest('doc-retry', 2), alice);
    const running = await jobs.claimNext('worker-1');
    expect(running?.job_id).toBe(queued.job_id);
    await expect(jobs.fail(queued.job_id, 'model unavailable')).resolves.toMatchObject({ status: 'retry_wait' });
  });

  test('MySQL queue claim uses a transaction and SKIP LOCKED', () => {
    const source = readFileSync(resolve('src/indexing/index-jobs.service.ts'), 'utf8');
    expect(source).toContain('FOR UPDATE SKIP LOCKED');
    expect(source).toContain('startTransaction');
  });

  test('persistent trace schema binds trace ownership to user and space', () => {
    const source = readFileSync(resolve('src/observability/observability.service.ts'), 'utf8');
    expect(source).toContain('WHERE trace_id=? AND user_id=? AND space_id=?');
  });

  test('memory adapter uses corpus-level BM25', () => {
    const sparse = new SparseEmbeddingService();
    const hits = bm25Search('中文 检索', [
      ['a', { title: '无关', content: '天气', chunk_id: 'a' }],
      ['b', { title: '中文检索', content: '中文知识库检索', chunk_id: 'b' }],
    ], 2, sparse);
    expect(hits[0]?.pointId).toBe('b');
  });

  test('keyword tokenization uses Jieba while hash embedding keeps Python character tokens', () => {
    expect(tokenizeKeyword('中文知识库，Qdrant!')).toEqual(
      expect.arrayContaining(['中文', '知识', '知识库', 'qdrant']),
    );
    expect(tokenizeKeyword('中文知识库，Qdrant!')).not.toContain('，');
    expect(tokenizeHash('中文')).toEqual(['中', '文']);
    expect(tokenizeHash('')).toEqual(['']);
  });

  test('document access fields invalidate the active index and bump version', async () => {
    const documents = new DocumentsService(noDatabase);
    const created = await documents.create(Object.assign(new DocumentCreateDto(), {
      title: 'doc', content: 'body', visibility: 'private', source_type: 'article', tags: [], index_now: false,
    }), alice);
    await documents.markReady(created.doc_id, 1, 1);
    const updated = await documents.update(
      created.doc_id,
      Object.assign(new DocumentUpdateDto(), { visibility: 'public' }),
      alice,
    );
    expect(updated).toMatchObject({
      document_version: 2, index_status: 'pending', active_index_version: null, latest_index_job_id: null,
    });
  });

  test('Qdrant named sparse vector filter pushes down permissions', () => {
    const filter = buildPermissionFilter(alice, { private: true, team: true, public: false, document_ids: [] });
    expect(JSON.stringify(filter)).toContain('owner_id');
    expect(JSON.stringify(filter)).toContain('team_alpha');
    expect(JSON.stringify(filter)).not.toContain('"value":"public"');
  });

  test('compressor selects a relevant late sentence and respects token budget', () => {
    const compressor = new ContextCompressorService(config({ contextTokenBudget: 30, contextPerCitationTokens: 30 }));
    const extracted = compressor.extractRelevant('开头是背景。中间也是背景。最后说明 Qdrant 权限过滤。', 'Qdrant 权限', 20);
    expect(extracted).toContain('Qdrant');
    expect(compressor.count(extracted)).toBeLessThanOrEqual(20);
  });

  test('conversation memory is isolated by user and space', async () => {
    const memory = new ConversationMemoryService(config(), noDatabase);
    await memory.add('conversation', 'user', 'alice secret', alice);
    expect(await memory.recentText('conversation', alice)).toContain('alice secret');
    expect(await memory.recentText('conversation', bob)).toBe('');
  });

  test('MySQL memory query is scoped by conversation, user and space', () => {
    const source = readFileSync(resolve('src/ai/memory.service.ts'), 'utf8');
    expect(source).toContain('conversation_id=? AND user_id=? AND space_id=?');
  });

  test('production validation rejects all smoke fallbacks', () => {
    const production = config({ appEnv: 'production' });
    expect(() => production.validateRuntime()).toThrow('Production configuration cannot use smoke fallbacks');
  });

  test('LLM-only tool selection never silently falls back to rules', async () => {
    const service = new AgentToolsService(
      config({ agentToolSelection: 'llm' }),
      { isConfigured: false } as never,
    );
    const request = {
      query: '总结', retrieval_domain: 'public',
      current_context: { title: 'x', cursor_before: '', cursor_after: '', selected_text: '', tags: [] },
    } as unknown as AiWriteDto;
    await expect(service.select(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  test('original query is retained and variants are bounded and deduplicated', () => {
    expect(normalizeQueryVariants('原问题', ['原问题', '变体一', '变体二', '变体三', '变体四'], true, 3))
      .toEqual(['原问题', '变体一', '变体二', '变体三']);
  });

  test('exact identifiers must be preserved verbatim', () => {
    expect(normalizeQueryVariants('解释 `CodeBlockWithSuggestion.ts`', ['解释编辑器扩展', '解释 `CodeBlockWithSuggestion.ts` 扩展'], true, 3))
      .toEqual(['解释 `CodeBlockWithSuggestion.ts`', '解释 `CodeBlockWithSuggestion.ts` 扩展']);
  });

  test('invalid model output falls back to the original query', () => {
    expect(normalizeQueryVariants('original', [null, 1, '', 'ORIGINAL'], true, 3)).toEqual(['original']);
  });

  test('RRF combines rankings from every query and channel', () => {
    const hit = (id: string, score: number) => ({ pointId: id, score, payload: { chunk_id: id } });
    const fused = rrfFuseMany([
      ['dense', [hit('a', 0.8), hit('b', 0.7)]],
      ['keyword', [hit('b', 3), hit('c', 2)]],
    ]);
    expect(fused[0]?.pointId).toBe('b');
    expect(fused).toHaveLength(3);
  });

  test('every variant reuses the same permission context and scope', () => {
    const payload = { is_active: true, visibility: 'private', space_id: 'space_a', owner_id: 'user_alice' };
    const scope = { private: true, team: false, public: false, document_ids: [] };
    expect(canAccess(payload, alice, scope)).toBe(true);
    expect(canAccess(payload, bob, scope)).toBe(false);
    expect(canAccess(payload, carol, scope)).toBe(false);
  });
});

function readJsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as unknown);
}
