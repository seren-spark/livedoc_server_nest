import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import supertest from 'supertest';
import { bootstrap } from '../src/main.js';
import { NO_EVIDENCE_MESSAGE } from '../src/ai/ai-writer.service.js';
import { RetrievalService } from '../src/retrieval/retrieval.service.js';
import { VectorStoreService } from '../src/retrieval/vector-store.service.js';

describe('Python 34-test parity - Supertest API contracts', () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let aliceToken: string;
  let bobToken: string;
  let carolToken: string;

  beforeAll(async () => {
    app = await bootstrap();
    await app.getHttpAdapter().getInstance().ready();
    api = supertest(app.getHttpServer());
    aliceToken = await login(api, 'alice@livedoc.local');
    bobToken = await login(api, 'bob@livedoc.local');
    carolToken = await login(api, 'carol@livedoc.local');
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  test('private documents are owner scoped', async () => {
    const created = await api.post('/documents').set(auth(aliceToken)).send({ title: 'Alice 私有', content: '只有 Alice', index_now: false }).expect(201);
    await api.get(`/documents/${created.body.doc_id}`).set(auth(aliceToken)).expect(200);
    await api.get(`/documents/${created.body.doc_id}`).set(auth(bobToken)).expect(403);
  });

  test('team documents require membership', async () => {
    const created = await api.post('/documents').set(auth(aliceToken)).send({
      title: 'Alpha 团队', content: '团队资料', visibility: 'team', team_id: 'team_alpha', index_now: false,
    }).expect(201);
    await api.get(`/documents/${created.body.doc_id}`).set(auth(bobToken)).expect(200);
    await api.get(`/documents/${created.body.doc_id}`).set(auth(carolToken)).expect(403);
  });

  test('anonymous and cross-team writes are rejected', async () => {
    await api.post('/documents').send({ title: 'anonymous', content: 'x' }).expect(401);
    await api.post('/documents').set(auth(carolToken)).send({
      title: 'wrong team', content: 'x', visibility: 'team', team_id: 'team_alpha', index_now: false,
    }).expect(403);
  });

  test('document create only enqueues indexing work', async () => {
    const created = await api.post('/documents').set(auth(aliceToken)).send({ title: 'queued', content: '# h\ncontent' }).expect(202);
    expect(created.body).toMatchObject({ index_status: 'queued', chunk_count: 0 });
    const job = await api.get(`/index-jobs/${created.body.latest_index_job_id}`).set(auth(aliceToken)).expect(200);
    expect(job.body.status).toBe('queued');
  });

  test('frontend cannot supply query_variants', async () => {
    await api.post('/knowledge/search').set(auth(aliceToken)).send({ query: 'RAG', query_variants: ['bypass'] }).expect(422);
    await api.post('/ai/write').set(auth(aliceToken)).send({
      query: 'RAG', query_variants: ['bypass'], stream: false,
      current_context: { title: 'x' },
    }).expect(422);
  });

  test('current-document retrieval does not persist vectors', async () => {
    const store = app.get(VectorStoreService);
    const before = store.points.size;
    const retrieval = app.get(RetrievalService);
    const result = await retrieval.searchCurrentDocumentWithTrace({
      query: '权限', title: '当前文档', content: '# 权限\n权限过滤必须下推到检索。',
      context: { user_id: 'user_alice', space_id: 'space_a', team_ids: ['team_alpha'] },
    });
    expect(result.citations[0]?.doc_id).toBe('current_document');
    expect(store.points.size).toBe(before);
  });

  test('completed trace links to feedback metrics and enforces trace ownership', async () => {
    const completion = await api.post('/ai/write').set(auth(aliceToken)).send({
      intent: 'knowledge_qa', query: '不会命中的内容', retrieval_domain: 'private', stream: false,
      current_context: { title: '空文档' },
    }).expect(200);
    const traceId = completion.body.trace.trace_id;
    await api.post('/ai/feedback').set(auth(aliceToken)).send({ trace_id: traceId, action: 'helpful' }).expect(200);
    await api.get(`/metrics/rag/traces/${traceId}`).set(auth(aliceToken)).expect(200);
    await api.get(`/metrics/rag/traces/${traceId}`).set(auth(bobToken)).expect(404);
    const bobTraces = await api.get('/metrics/rag/traces?window=24h').set(auth(bobToken)).expect(200);
    expect(bobTraces.body.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ trace_id: traceId })]),
    );
    const metrics = await api.get('/metrics/rag?window=24h').set(auth(aliceToken)).expect(200);
    expect(metrics.body.helpful_count).toBeGreaterThanOrEqual(1);
  });

  test('stream emits tool_call, tool_result and meta before answer events', async () => {
    const response = await api.post('/ai/write').set(auth(carolToken)).send({
      intent: 'knowledge_qa', query: '仅用于验证无证据事件顺序', retrieval_domain: 'private', stream: true,
      current_context: { title: '空文档' },
    }).expect(200).expect('content-type', /text\/event-stream/u);
    const events = [...response.text.matchAll(/^event: (.+)$/gmu)].map((match) => match[1]);
    expect(events.slice(0, 3)).toEqual(['tool_call', 'tool_result', 'meta']);
    expect(events.at(-1)).toBe('done');
    expect(events.indexOf('delta')).toBeGreaterThan(events.indexOf('meta'));
  });

  test('editor tasks use ephemeral context without vector persistence', async () => {
    const store = app.get(VectorStoreService);
    const before = store.points.size;
    const response = await api.post('/ai/write').set(auth(aliceToken)).send({
      intent: 'correct_text', query: '纠错', stream: false,
      current_context: { title: '当前文档', selected_text: '这是一段需要纠错得文本。' },
      current_document: { title: '当前文档', content: '这是一段需要纠错得文本。' },
    }).expect(503);
    expect(JSON.stringify(response.body)).not.toContain(NO_EVIDENCE_MESSAGE);
    expect(store.points.size).toBe(before);
  });

  test('no-evidence refusal blocks knowledge answers but not editor tasks', async () => {
    const knowledge = await api.post('/ai/write').set(auth(carolToken)).send({
      intent: 'knowledge_qa', query: '没有资料的问题', retrieval_domain: 'private', stream: false,
      current_context: { title: 'x' },
    }).expect(200);
    expect(knowledge.body.answer).toBe(NO_EVIDENCE_MESSAGE);
    const editor = await api.post('/ai/write').set(auth(carolToken)).send({
      intent: 'summarize_document', query: '总结', stream: false,
      current_context: { title: 'x' }, current_document: { title: 'x', content: '有内容' },
    }).expect(503);
    expect(JSON.stringify(editor.body)).not.toContain(NO_EVIDENCE_MESSAGE);
  });

  test('SSE client cancellation closes the request without crashing the service', async () => {
    await new Promise<void>((resolve) => {
      const request = api.post('/ai/write').set(auth(carolToken)).send({
        intent: 'knowledge_qa', query: 'cancel', retrieval_domain: 'private', stream: true,
        current_context: { title: 'x' },
      }).end(() => undefined);
      setImmediate(() => {
        request.abort();
        resolve();
      });
    });
    await api.get('/health').expect(200);
  });
});

async function login(api: ReturnType<typeof supertest>, email: string): Promise<string> {
  const response = await api.post('/dev/auth/login').send({ email, password: 'Demo@123456' }).expect(200);
  return response.body.token as string;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
