import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { jest } from '@jest/globals';
import supertest from 'supertest';
import { bootstrap } from '../src/main.js';
import { NO_EVIDENCE_MESSAGE } from '../src/ai/ai-writer.service.js';
import { RetrievalService } from '../src/retrieval/retrieval.service.js';
import { VectorStoreService } from '../src/retrieval/vector-store.service.js';
import { DoclingParserService } from '../src/document-imports/docling-parser.service.js';
import { ImportWorkerService } from '../src/document-imports/import-worker.service.js';
import { IndexJobsService } from '../src/indexing/index-jobs.service.js';

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

  test('PDF import is reviewed in the existing editor before one idempotent index job', async () => {
    const parser = app.get(DoclingParserService);
    jest.spyOn(parser, 'parse').mockResolvedValueOnce({
      title: '解析标题',
      markdown: '# 解析标题\n\n正文\n\n![图片](asset://pending/1)',
      parser_version: 'fake-docling/1',
      images: [{
        filename: 'figure.png', mime_type: 'image/png', data_base64: Buffer.from('image-bytes').toString('base64'),
        ordinal: 1, page_number: 2, width: 640, height: 480,
        ocr_text: '图中文字', ocr_error: null,
      }],
    });
    const uploaded = await api.post('/document-imports').set(auth(aliceToken))
      .attach('file', Buffer.from('%PDF-1.4\nfake'), { filename: 'handbook.pdf', contentType: 'application/pdf' })
      .field('visibility', 'public').field('tags', '["产品"]')
      .expect(202);
    expect(uploaded.body.status).toBe('queued');
    await api.get(`/document-imports/${uploaded.body.import_id}`).set(auth(bobToken)).expect(403);

    const worker = app.get(ImportWorkerService);
    await worker.runOnce('e2e-import-worker');
    const reviewed = await api.get(`/document-imports/${uploaded.body.import_id}`).set(auth(aliceToken)).expect(200);
    expect(reviewed.body).toMatchObject({ status: 'review_ready', parser_version: 'fake-docling/1' });
    const image = reviewed.body.assets.find((asset: { kind: string }) => asset.kind === 'image');
    expect(image).toMatchObject({ ocr_text: '图中文字', page_number: 2 });
    expect(image.storage_key).toBeUndefined();

    await api.patch(`/document-imports/${uploaded.body.import_id}`).set(auth(aliceToken)).send({
      title: '审核标题', content: `# 审核标题\n\n正文\n\n![图](asset://${image.asset_id})`,
      editor_content: { type: 'doc', content: [] }, asset_ids: [image.asset_id],
    }).expect(200);
    const confirmed = await api.post(`/document-imports/${uploaded.body.import_id}/confirm`).set(auth(aliceToken)).expect(202);
    expect(confirmed.body.document.content).not.toContain('图中文字');
    const jobs = app.get(IndexJobsService);
    const queued = await jobs.get(confirmed.body.index_job.job_id);
    expect(queued?.request_payload.content).toContain('图中文字');
    await api.get(image.content_url).set(auth(bobToken)).expect(200);
    await api.patch(`/documents/${confirmed.body.document.doc_id}`).set(auth(bobToken))
      .send({ title: '越权修改' }).expect(403);
    const repeated = await api.post(`/document-imports/${uploaded.body.import_id}/confirm`).set(auth(aliceToken)).expect(202);
    expect(repeated.body.document.doc_id).toBe(confirmed.body.document.doc_id);
    expect(repeated.body.index_job.job_id).toBe(confirmed.body.index_job.job_id);
    await api.delete(`/documents/${confirmed.body.document.doc_id}`).set(auth(aliceToken)).expect(200);
    await api.get(image.content_url).set(auth(aliceToken)).expect(404);
  });

  test('document import rejects extension-only PDF uploads', async () => {
    await api
      .post('/document-imports')
      .set(auth(aliceToken))
      .attach('file', Buffer.from('not-a-pdf'), {
        filename: 'spoofed.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
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

  test('stream emits meta and visible tool execution before answer events', async () => {
    const response = await api.post('/ai/write').set(auth(carolToken)).send({
      intent: 'knowledge_qa', query: '仅用于验证无证据事件顺序', retrieval_domain: 'private', stream: true,
      current_context: { title: '空文档' },
    }).expect(200).expect('content-type', /text\/event-stream/u);
    const events = [...response.text.matchAll(/^event: (.+)$/gmu)].map((match) => match[1]);
    expect(events.slice(0, 3)).toEqual(['meta', 'tool_start', 'tool_result']);
    expect(events.indexOf('citations')).toBeGreaterThan(events.indexOf('delta'));
    expect(events.indexOf('citations')).toBeLessThan(events.indexOf('done'));
    expect(events.at(-1)).toBe('done');
    expect(events.indexOf('delta')).toBeGreaterThan(events.indexOf('meta'));
  });

  test('hijacked SSE response preserves CORS headers for an allowed IPv6 local origin', async () => {
    const origin = 'http://[::1]:5173';
    const response = await api.post('/ai/write')
      .set(auth(carolToken))
      .set('Origin', origin)
      .send({
        intent: 'knowledge_qa', query: '验证 SSE CORS', retrieval_domain: 'private', stream: true,
        current_context: { title: '空文档' },
      })
      .expect(200)
      .expect('content-type', /text\/event-stream/u);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
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
    expect(knowledge.body.has_evidence).toBe(false);
    expect(knowledge.body.can_insert).toBe(false);
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
