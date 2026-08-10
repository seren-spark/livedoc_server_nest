import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

type Json = Record<string, any>;
const REFUSAL = '知识库未查询到相关依据，无法作答';
const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'canceled']);

function argument(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJsonLines(path: string): Json[] {
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as Json; }
    catch (error) { throw new Error(`${path}:${index + 1} JSON 无效：${String(error)}`); }
  });
}

function validateAssets(corpus: Json[], cases: Json[]) {
  if (corpus.length !== 18 || cases.length !== 60) throw new Error(`评估集应为 18 篇文档/60 个问题，实际 ${corpus.length}/${cases.length}`);
  const ids = new Set(corpus.map((item) => item.doc_id));
  const missing = cases.flatMap((item) => [...(item.relevant_doc_ids ?? []), ...(item.forbidden_doc_ids ?? [])]).filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`评估问题引用了不存在的文档：${[...new Set(missing)].join(',')}`);
}

async function request(baseUrl: string, path: string, init: RequestInit = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* retain text */ }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  return { body, latency: Math.round((performance.now() - started) * 100) / 100 };
}

async function login(baseUrl: string, email: string, password: string) {
  const { body } = await request(baseUrl, '/dev/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  return { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' };
}

function strictPreflight(health: Json) {
  const expected: Json = { runtime_mode: 'real', metadata_store: 'mysql', memory_store: 'mysql', index_job_store: 'mysql', import_job_store: 'mysql', observability_store: 'mysql', vector_store: 'qdrant', embedding_provider: 'transformers', sparse_embedding_provider: 'qdrant_idf', rerank_provider: 'bge', agent_tool_selection: 'llm' };
  const failures = Object.entries(expected).filter(([key, value]) => health[key] !== value).map(([key, value]) => `${key}=${String(health[key])}, expected ${value}`);
  if (!health.llm_configured) failures.push('llm_configured=false');
  if (failures.length) throw new Error(`真实环境预检失败：${failures.join('; ')}`);
}

async function seedCorpus(baseUrl: string, corpus: Json[], headers: Map<string, Record<string, string>>, timeoutMs: number) {
  const jobs: Array<{ id: string; owner: string }> = [];
  for (const doc of corpus) {
    const auth = headers.get(doc.owner_email)!;
    const current = await fetch(`${baseUrl}/documents/${doc.doc_id}`, { headers: auth });
    let body: Json;
    if (current.status === 404) {
      body = (await request(baseUrl, '/documents', { method: 'POST', headers: auth, body: JSON.stringify({ ...doc, owner_email: undefined, index_now: true }) })).body;
    } else {
      const existing = await current.json() as Json;
      body = (await request(baseUrl, `/documents/${doc.doc_id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ title: doc.title, content: doc.content, visibility: doc.visibility, source_type: doc.source_type, tags: doc.tags, url: doc.url, expected_version: existing.document_version }) })).body;
      body = (await request(baseUrl, `/documents/${doc.doc_id}/reindex`, { method: 'POST', headers: auth })).body;
    }
    const jobId = body.job_id ?? body.latest_index_job_id;
    if (!jobId) throw new Error(`${doc.doc_id} 未返回索引任务`);
    jobs.push({ id: jobId, owner: doc.owner_email });
  }
  const deadline = Date.now() + timeoutMs;
  while (jobs.length && Date.now() < deadline) {
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      const job = jobs[index]!;
      const { body } = await request(baseUrl, `/index-jobs/${job.id}`, { headers: headers.get(job.owner)! });
      if (!TERMINAL.has(body.status)) continue;
      if (body.status !== 'succeeded') throw new Error(`索引任务 ${job.id} 结束为 ${body.status}: ${body.error ?? ''}`);
      jobs.splice(index, 1);
    }
    if (jobs.length) await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  if (jobs.length) throw new Error(`${jobs.length} 个索引任务等待超时`);
}

function normalize(value: unknown) { return String(value ?? '').replace(/\s+/gu, '').toLowerCase(); }
function mean(values: number[]) { return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10_000) / 10_000 : 0; }
function percentile(values: number[], quantile: number) { if (!values.length) return 0; const sorted = [...values].sort((a,b)=>a-b); return sorted[Math.round((sorted.length - 1) * quantile)] ?? 0; }

function gradeCase(testCase: Json, search: Json, answer: Json) {
  const searchCitations = search.citations ?? [];
  const answerCitations = answer.citations ?? [];
  const returned = searchCitations.map((item: Json) => String(item.doc_id));
  const returnedChunks = searchCitations.map((item: Json) => String(item.chunk_id));
  const answerDocs = answerCitations.map((item: Json) => String(item.doc_id));
  const answerChunks = answerCitations.map((item: Json) => String(item.chunk_id));
  const relevant = new Set<string>(testCase.relevant_doc_ids ?? []);
  const forbidden = new Set<string>(testCase.forbidden_doc_ids ?? []);
  const normalized = normalize(answer.answer);
  const facts = (testCase.required_facts ?? []).map((alternatives: string[]) => alternatives.some((item) => normalized.includes(normalize(item))));
  const factCoverage = facts.length ? facts.filter(Boolean).length / facts.length : 1;
  const retrievedEvidence = normalize(
    searchCitations
      .map((item: Json) => item.content ?? item.snippet ?? '')
      .join('\n'),
  );
  const evidenceGroups = testCase.required_evidence ?? testCase.required_facts ?? [];
  const evidenceMatches = evidenceGroups.map((alternatives: string[]) =>
    alternatives.some((item) => retrievedEvidence.includes(normalize(item))),
  );
  const evidenceCoverage = evidenceMatches.length
    ? evidenceMatches.filter(Boolean).length / evidenceMatches.length
    : 1;
  const leaked = [...new Set([...returned, ...answerDocs])].filter((id) => forbidden.has(id));
  const forbiddenFacts = (testCase.forbidden_facts ?? []).filter((item: string) => normalized.includes(normalize(item)));
  const expectedRefusal = Boolean(testCase.expected_refusal);
  const refused = String(answer.answer ?? '').includes(REFUSAL);
  const references = [...String(answer.answer ?? '').matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
  const citationIds = new Set(answerCitations.map((item: Json) => item.citation_id));
  const citationShapeValid = answerCitations.every((item: Json) => item.citation_id && item.doc_id && item.chunk_id && item.document_version && item.source_anchor && citationIds.size === answerCitations.length);
  const citationValidity = expectedRefusal && !references.length && !answerCitations.length ? 1 : Number(Boolean(answerCitations.length && references.length && citationShapeValid && references.every((index) => index >= 1 && index <= answerCitations.length)));
  const permissionLeak = Boolean(leaked.length || forbiddenFacts.length);
  const retrievalComplete = !relevant.size || [...relevant].every((id) => returned.includes(id));
  const answerSourceComplete = !relevant.size || [...relevant].some((id) => answerDocs.includes(id));
  const verdict = permissionLeak || (expectedRefusal && !refused) ? 'fail' : expectedRefusal ? 'pass' : !retrievalComplete || !answerSourceComplete || factCoverage === 0 ? 'fail' : factCoverage < 1 || citationValidity < 1 ? 'review' : 'pass';
  return { verdict, returned_doc_ids: returned, returned_chunk_ids: returnedChunks, answer_doc_ids: answerDocs, answer_chunk_ids: answerChunks, retrieval_evidence_coverage: evidenceCoverage, fact_coverage: factCoverage, citation_validity: citationValidity, expected_refusal: expectedRefusal, refused, permission_leak: permissionLeak, leaked_doc_ids: leaked, forbidden_fact_hits: forbiddenFacts };
}

function metrics(results: Json[], topK: number) {
  const evidence = results.filter((item) => (item.relevant_doc_ids ?? []).length);
  const recalls = evidence.map((item) => { const relevant = new Set(item.relevant_doc_ids); const returned = new Set(item.grade.returned_doc_ids.slice(0, topK)); return [...relevant].filter((id) => returned.has(id)).length / relevant.size; });
  const mrr = evidence.map((item) => { const relevant = new Set(item.relevant_doc_ids); const rank = item.grade.returned_doc_ids.findIndex((id: string) => relevant.has(id)); return rank < 0 ? 0 : 1 / (rank + 1); });
  const ndcg = evidence.map((item) => { const relevant = new Set(item.relevant_doc_ids); const ranked = item.grade.returned_doc_ids.slice(0, topK); const dcg = ranked.reduce((sum: number, id: string, index: number) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0); const ideal = [...Array(Math.min(relevant.size, topK)).keys()].reduce((sum, index) => sum + 1 / Math.log2(index + 2), 0); return ideal ? dcg / ideal : 0; });
  const grades = results.map((item) => item.grade);
  return {
    case_count: results.length, recall_at_k: mean(recalls), mrr: mean(mrr), ndcg_at_k: mean(ndcg),
    citation_validity: mean(grades.map((item) => item.citation_validity)), retrieval_evidence_coverage: mean(evidence.map((item) => item.grade.retrieval_evidence_coverage)), answer_fact_coverage: mean(grades.map((item) => item.fact_coverage)),
    refusal_accuracy: mean(grades.map((item) => Number(item.refused === item.expected_refusal))), permission_leak_rate: mean(grades.map((item) => Number(item.permission_leak))),
    generation_success_rate: mean(results.map((item) => Number(!item.error))), adoption_rate: null,
    pass_count: grades.filter((item) => item.verdict === 'pass').length, review_count: grades.filter((item) => item.verdict === 'review').length, fail_count: grades.filter((item) => item.verdict === 'fail').length,
    search_p50_ms: percentile(results.map((item) => item.search_latency_ms), .5), search_p95_ms: percentile(results.map((item) => item.search_latency_ms), .95), answer_p50_ms: percentile(results.map((item) => item.answer_latency_ms), .5), answer_p95_ms: percentile(results.map((item) => item.answer_latency_ms), .95),
  };
}

const evalRoot = resolve(argument('--eval-root', 'evals')!);
const corpusPath = resolve(argument('--corpus', resolve(evalRoot, 'rag_corpus.jsonl'))!);
const casesPath = resolve(argument('--dataset', resolve(evalRoot, 'rag_cases.jsonl'))!);
if (!existsSync(corpusPath) || !existsSync(casesPath)) throw new Error('RAG 评估 manifest 不存在');
const corpus = readJsonLines(corpusPath);
const cases = readJsonLines(casesPath);
validateAssets(corpus, cases);
if (process.argv.includes('--validate-only')) {
  console.log(JSON.stringify({ status: 'valid', corpus_documents: corpus.length, cases: cases.length }));
  process.exit(0);
}

const baseUrl = argument('--base-url', process.env.RAG_API_BASE_URL ?? 'http://127.0.0.1:8001')!;
const password = argument('--password', process.env.RAG_EVAL_PASSWORD ?? 'Demo@123456')!;
const topK = Number(argument('--top-k', '10'));
const health = (await request(baseUrl, '/health')).body;
strictPreflight(health);
const identities = [...new Set([...corpus.map((item) => item.owner_email), ...cases.map((item) => item.identity)])];
const headers = new Map<string, Record<string, string>>();
for (const email of identities) headers.set(email, await login(baseUrl, email, password));
if (process.argv.includes('--seed-eval')) await seedCorpus(baseUrl, corpus, headers, Number(argument('--wait-timeout', '900000')));

const completed: Json[] = [];
for (const testCase of cases) {
  try {
    const search = await request(baseUrl, '/knowledge/search', { method: 'POST', headers: headers.get(testCase.identity)!, body: JSON.stringify({ query: testCase.query, scope: testCase.scope, top_k: topK, mode: 'hybrid' }) });
    const domain = testCase.scope.team ? 'team' : testCase.scope.private ? 'private' : 'public';
    const answer = await request(baseUrl, '/ai/write', { method: 'POST', headers: headers.get(testCase.identity)!, body: JSON.stringify({ intent: 'knowledge_qa', query: testCase.query, current_context: { title: 'RAG evaluation' }, scope: testCase.scope, retrieval_domain: domain, stream: false }) });
    completed.push({ ...testCase, search_latency_ms: search.latency, answer_latency_ms: answer.latency, search: search.body, answer: answer.body, grade: gradeCase(testCase, search.body, answer.body) });
  } catch (error) {
    completed.push({ ...testCase, search_latency_ms: 0, answer_latency_ms: 0, error: String(error), grade: { verdict: 'fail', returned_doc_ids: [], returned_chunk_ids: [], answer_doc_ids: [], answer_chunk_ids: [], retrieval_evidence_coverage: 0, fact_coverage: 0, citation_validity: 0, expected_refusal: Boolean(testCase.expected_refusal), refused: false, permission_leak: false } });
  }
}

const runId = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
const outputRoot = resolve(argument('--output-dir', 'evals/results')!, runId);
mkdirSync(outputRoot, { recursive: true });
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* no git */ }
const report = { run_id: runId, git_commit: commit, dataset_sha256: createHash('sha256').update(readFileSync(casesPath)).digest('hex'), environment: health, top_k: topK, metrics: metrics(completed, topK), cases: completed };
writeFileSync(resolve(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
writeFileSync(resolve(outputRoot, 'cases.jsonl'), `${completed.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
writeFileSync(resolve(outputRoot, 'review.csv'), `case_id,category,auto_verdict,human_verdict,reviewer,notes\n${completed.filter((item) => item.grade.verdict !== 'pass').map((item) => `${item.case_id},${item.category},${item.grade.verdict},pending,,`).join('\n')}\n`, 'utf8');
writeFileSync(resolve(outputRoot, 'summary.md'), `# LiveDoc RAG Evaluation ${runId}\n\n\`\`\`json\n${JSON.stringify(report.metrics, null, 2)}\n\`\`\`\n\n> adoption_rate 需要真实用户 inserted 反馈，离线评估不伪造该指标。\n`, 'utf8');
console.log(JSON.stringify({ run_dir: outputRoot, metrics: report.metrics }, null, 2));
if (report.metrics.permission_leak_rate !== 0 || report.metrics.citation_validity !== 1) process.exitCode = 2;
