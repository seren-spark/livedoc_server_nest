import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import supertest from 'supertest';
import { ZipFile } from 'yazl';

process.env.LIVEDOC_SKIP_AUTO_START = 'true';

// Load the complete Nest graph before importing provider tokens. Concurrent
// dynamic imports can expose partially evaluated classes to decorator metadata.
const { bootstrap } = await import('../src/main.js');
const app = await bootstrap();
const { AppConfig } = await import('../src/config/app-config.js');
const { DatabaseService } = await import('../src/database/database.service.js');
const { ImportWorkerService } = await import('../src/document-imports/import-worker.service.js');
const { DocumentImportsService } = await import('../src/document-imports/document-imports.service.js');
const { IndexWorkerService } = await import('../src/indexing/index-worker.service.js');

const runId = new Date().toISOString().replace(/[-:.]/gu, '');
const marker = `LIVEDOC-E2E-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
const expectedFact = '蓝绿色';
const keepData = process.argv.includes('--keep-data');
await app.getHttpAdapter().getInstance().ready();
const api = supertest(app.getHttpServer());
const config = app.get(AppConfig);
const database = app.get(DatabaseService);
const imports = app.get(DocumentImportsService);
let token = '';
let importId = '';
let docId = '';
const traceIds = new Set<string>();
const report: Record<string, unknown> = {
  run_id: runId,
  marker,
  config_fingerprint: config.configFingerprint,
  collection: config.qdrantCollection,
  started_at: new Date().toISOString(),
};

try {
  config.validateRuntime();
  await assertQueuesIdle(database);
  const health = await api.get('/health/ready').expect(200);
  report.health = health.body;

  const login = await api
    .post('/dev/auth/login')
    .send({
      email: 'alice@livedoc.local',
      password: process.env.RAG_EVAL_PASSWORD ?? 'Demo@123456',
    })
    .expect(200);
  token = String(login.body.token);
  const authorization = { Authorization: `Bearer ${token}` };

  const documentText = `验收标识 ${marker} 用于验证 LiveDoc 的真实引用链路。回答关键词：${expectedFact}。`;
  const docx = await createDocx('LiveDoc 真实 RAG E2E', documentText);
  const upload = await api
    .post('/document-imports')
    .set(authorization)
    .attach('file', docx, {
      filename: `livedoc-real-e2e-${runId}.docx`,
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    .field('title', `LiveDoc 真实 RAG E2E ${runId}`)
    .field('visibility', 'public')
    .field('tags', '["真实E2E","引用验收"]')
    .expect(202);
  importId = String(upload.body.import_id);
  // Import confirmation uses a deterministic document id. Assign it before
  // confirmation so cleanup can remove a document even if the transaction/API
  // fails after document creation but before the response is returned.
  docId = `import_${importId}`;
  report.import_id = importId;

  const imported = await runWorkerUntilResult(
    () => app.get(ImportWorkerService).runOnce(`e2e-import-${runId}`),
  );
  if (!imported || imported.import_id !== importId) {
    throw new Error('The in-process import worker did not claim the E2E import. Stop external workers and retry.');
  }
  const review = await api
    .get(`/document-imports/${importId}`)
    .set(authorization)
    .expect(200);
  if (review.body.status !== 'review_ready') {
    throw new Error(`Docling import ended as ${String(review.body.status)}: ${String(review.body.error ?? '')}`);
  }
  if (!String(review.body.parsed_content).includes(marker)) {
    throw new Error('Docling output lost the unique E2E marker.');
  }
  report.parser_version = review.body.parser_version;

  const confirmation = await api
    .post(`/document-imports/${importId}/confirm`)
    .set(authorization)
    .expect(202);
  const confirmedDocId = String(confirmation.body.document.doc_id);
  if (confirmedDocId !== docId) {
    throw new Error(`Import confirmation returned unexpected document id ${confirmedDocId}.`);
  }
  const indexJobId = String(confirmation.body.index_job.job_id);
  report.document_id = docId;
  report.index_job_id = indexJobId;
  const [jobBeforeClaim] = await database.query<Record<string, unknown>>(
    `SELECT job_id,status,next_run_at,lease_expires_at,UTC_TIMESTAMP(6) AS database_now,
            (next_run_at IS NULL OR next_run_at <= UTC_TIMESTAMP(6)) AS is_due
     FROM index_jobs WHERE job_id=?`,
    [indexJobId],
  );
  report.index_job_before_claim = jobBeforeClaim ?? null;

  const indexed = await runWorkerUntilResult(
    () => app.get(IndexWorkerService).runOnce(`e2e-index-${runId}`),
  );
  if (!indexed || indexed.job_id !== indexJobId || indexed.status !== 'succeeded') {
    const [jobAfterClaim] = await database.query<Record<string, unknown>>(
      `SELECT job_id,status,attempts,next_run_at,lease_expires_at,worker_id,error,
              UTC_TIMESTAMP(6) AS database_now
       FROM index_jobs WHERE job_id=?`,
      [indexJobId],
    );
    report.index_job_after_claim = jobAfterClaim ?? null;
    throw new Error(
      `Index job did not succeed: ${indexed?.job_id ?? 'none'} / ${indexed?.status ?? 'none'} / ${indexed?.error ?? ''}; ` +
      `state=${JSON.stringify(jobAfterClaim ?? null)}`,
    );
  }

  const question = `请检索知识库并根据来源回答：验收标识 ${marker} 对应的回答关键词是什么？`;
  const search = await api
    .post('/knowledge/search')
    .set(authorization)
    .send({
      query: question,
      scope: { public: true, private: false, team: false, document_ids: [] },
      top_k: 10,
      mode: 'hybrid',
    })
    .expect(200);
  const sourceCitation = search.body.citations?.find(
    (citation: Record<string, unknown>) => citation.doc_id === docId,
  );
  assertCitation(sourceCitation, marker);
  traceIds.add(String(search.body.trace.trace_id));
  report.search_trace_id = search.body.trace.trace_id;
  report.search_citation = sanitizeCitation(sourceCitation);

  const completion = await api
    .post('/ai/write')
    .set(authorization)
    .send({
      query: question,
      retrieval_domain: 'public',
      current_context: { title: '真实 E2E 验收', tags: [] },
      current_document: { title: '真实 E2E 验收', content: '' },
      stream: false,
    });
  if (completion.status !== 200) {
    report.completion_error = completion.body;
    throw new Error(
      `AI completion returned HTTP ${completion.status}: ${JSON.stringify(completion.body)}`,
    );
  }
  if (completion.body.tool_call?.name !== 'search_knowledge_base') {
    throw new Error(`Function Call selected ${String(completion.body.tool_call?.name)} instead of search_knowledge_base.`);
  }
  if (completion.body.tool_call?.source !== 'llm_function_call') {
    throw new Error(`Tool selection did not use the LLM Function Call path.`);
  }
  if (!String(completion.body.answer).includes(expectedFact)) {
    throw new Error(`Grounded answer did not contain the expected fact '${expectedFact}'.`);
  }
  if (!/\[\d+\]/u.test(String(completion.body.answer))) {
    throw new Error('Grounded answer did not contain a validated citation index.');
  }
  if (!completion.body.citations?.some((citation: Record<string, unknown>) => citation.doc_id === docId)) {
    throw new Error('Grounded answer did not retain the E2E source citation.');
  }
  traceIds.add(String(completion.body.trace.trace_id));
  report.completion_trace_id = completion.body.trace.trace_id;
  report.tool_call = completion.body.tool_call;
  report.answer = completion.body.answer;

  const streamed = await api
    .post('/ai/write')
    .set(authorization)
    .send({
      query: question,
      retrieval_domain: 'public',
      current_context: { title: '真实 E2E SSE 验收', tags: [] },
      current_document: { title: '真实 E2E SSE 验收', content: '' },
      stream: true,
    })
    .expect(200)
    .expect('content-type', /text\/event-stream/u);
  const parsedEvents = parseSseEvents(streamed.text);
  const events = parsedEvents.map((item) => item.event);
  assertSseOrder(events);
  const streamMeta = parsedEvents.find((item) => item.event === 'meta')?.data;
  const streamTraceId = String(streamMeta?.trace_id ?? '');
  if (!streamTraceId) throw new Error('SSE meta event did not include trace_id.');
  traceIds.add(streamTraceId);
  report.sse_trace_id = streamTraceId;
  report.sse_events = events;

  await api
    .post('/ai/feedback')
    .set(authorization)
    .send({ trace_id: completion.body.trace.trace_id, action: 'inserted' })
    .expect(200);
  const trace = await api
    .get(`/metrics/rag/traces/${completion.body.trace.trace_id}`)
    .set(authorization)
    .expect(200);
  if (trace.body.inserted !== true) {
    throw new Error('Inserted feedback was not persisted on the RAG trace.');
  }

  report.status = 'passed';
  report.completed_at = new Date().toISOString();
  await saveReport(config.projectRoot, report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  report.completed_at = new Date().toISOString();
  await saveReport(config.projectRoot, report);
  throw error;
} finally {
  if (!keepData) {
    await cleanup({ api, authorization: token ? { Authorization: `Bearer ${token}` } : {}, database, imports, importId, docId, traceIds });
  }
  if (token) {
    await api.post('/dev/auth/logout').set({ Authorization: `Bearer ${token}` }).catch(() => undefined);
  }
  await app.close();
}

async function assertQueuesIdle(database: InstanceType<typeof DatabaseService>) {
  const [indexQueue] = await database.query<{ total: number }>(
    "SELECT COUNT(*) AS total FROM index_jobs WHERE status IN ('queued','running','retry_wait')",
  );
  const [importQueue] = await database.query<{ total: number }>(
    "SELECT COUNT(*) AS total FROM document_import_jobs WHERE status IN ('queued','running','retry_wait')",
  );
  if (Number(indexQueue?.total ?? 0) || Number(importQueue?.total ?? 0)) {
    throw new Error(
      `Real E2E requires idle queues; index=${Number(indexQueue?.total ?? 0)}, import=${Number(importQueue?.total ?? 0)}. Finish or cancel existing jobs first.`,
    );
  }
}

function assertCitation(citation: Record<string, unknown> | undefined, marker: string) {
  if (!citation) throw new Error('Hybrid retrieval did not return the E2E document.');
  const start = Number(citation.start_offset);
  const end = Number(citation.end_offset);
  if (!citation.citation_id || !citation.chunk_id || !citation.source_anchor) {
    throw new Error('Citation is missing stable identity fields.');
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new Error('Citation is missing valid source offsets.');
  }
  if (!String(citation.snippet ?? citation.content).includes(marker)) {
    throw new Error('Citation snippet does not contain the E2E marker.');
  }
}

function assertSseOrder(events: string[]) {
  const required = ['meta', 'tool_start', 'tool_result', 'delta', 'citations', 'done'];
  let previous = -1;
  for (const event of required) {
    const index = events.indexOf(event);
    if (index <= previous) {
      throw new Error(`SSE event order is invalid: ${events.join(' -> ')}`);
    }
    previous = index;
  }
  if (events.includes('error')) {
    throw new Error(`SSE stream ended with error: ${events.join(' -> ')}`);
  }
}

function parseSseEvents(value: string): Array<{ event: string; data: Record<string, unknown> }> {
  return value.split(/\r?\n\r?\n/u).flatMap((block) => {
    const event = block.match(/^event:\s*(.+)$/mu)?.[1]?.trim();
    const rawData = block.match(/^data:\s*(.+)$/mu)?.[1]?.trim();
    if (!event || !rawData) return [];
    try {
      const parsed = JSON.parse(rawData) as unknown;
      return [{
        event,
        data: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {},
      }];
    } catch {
      throw new Error(`SSE event ${event} returned malformed JSON.`);
    }
  });
}

async function runWorkerUntilResult<T>(runOnce: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await runOnce();
    if (result) return result;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  } while (Date.now() < deadline);
  return null;
}

function sanitizeCitation(citation: Record<string, unknown>) {
  return {
    citation_id: citation.citation_id,
    doc_id: citation.doc_id,
    chunk_id: citation.chunk_id,
    document_version: citation.document_version,
    source_anchor: citation.source_anchor,
    start_offset: citation.start_offset,
    end_offset: citation.end_offset,
  };
}

async function cleanup(options: {
  api: ReturnType<typeof supertest>;
  authorization: Record<string, string>;
  database: InstanceType<typeof DatabaseService>;
  imports: InstanceType<typeof DocumentImportsService>;
  importId: string;
  docId: string;
  traceIds: Set<string>;
}) {
  if (options.docId && options.authorization.Authorization) {
    let deleted = false;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await options.api
        .delete(`/documents/${options.docId}`)
        .set(options.authorization)
        .catch(() => null);
      lastStatus = response?.status ?? 0;
      if (lastStatus === 200 || lastStatus === 404) {
        deleted = true;
        break;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 300 * (attempt + 1)));
    }
    if (!deleted) {
      throw new Error(`E2E cleanup could not delete document ${options.docId}; last HTTP status=${lastStatus}.`);
    }
  }
  if (options.importId) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = await options.imports.get(options.importId).catch(() => null);
      if (!record) break;
      await options.imports.remove(options.importId).catch(() => undefined);
    }
  }
  if (options.docId) {
    await options.database.query('DELETE FROM index_jobs WHERE doc_id=?', [options.docId]).catch(() => undefined);
  }
  const traces = [...options.traceIds].filter(Boolean);
  if (traces.length) {
    const placeholders = traces.map(() => '?').join(',');
    await options.database
      .query(`DELETE FROM rag_feedback_events WHERE trace_id IN (${placeholders})`, traces)
      .catch(() => undefined);
    await options.database
      .query(`DELETE FROM rag_traces WHERE trace_id IN (${placeholders})`, traces)
      .catch(() => undefined);
  }
}

async function saveReport(projectRoot: string, report: Record<string, unknown>) {
  const directory = resolve(projectRoot, 'evals', 'e2e-results');
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, `${String(report.run_id)}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
}

function createDocx(title: string, paragraph: string): Promise<Buffer> {
  const archive = new ZipFile();
  archive.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    ),
    '[Content_Types].xml',
  );
  archive.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
    '_rels/.rels',
  );
  archive.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${escapeXml(title)}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>` +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' +
        '</w:body></w:document>',
    ),
    'word/document.xml',
  );
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolveBuffer, reject) => {
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    archive.outputStream.once('error', reject);
    archive.outputStream.once('end', () => resolveBuffer(Buffer.concat(chunks)));
  });
  archive.end();
  return completed;
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
