import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprint, gradeCase, gradeRetrieval, summarize, validateAssets, validateRetrievalLabels, type Json } from '../src/evaluation/rag-evaluation.js';

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = (name: string) => process.argv.includes(name);
const jsonl = (path: string): Json[] => readFileSync(path, 'utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(l => l.trim()).map((l, i) => {
  try { return JSON.parse(l); } catch { throw new Error(`${path}:${i + 1} JSON 无效`); }
});
const save = (path: string, value: any) => { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(path + '.tmp', path); };
const identity = (d: Json) => ({ doc_id: d.doc_id, title: d.title, content: d.content, visibility: d.visibility ?? 'private',
  source_type: d.source_type ?? 'article', team_id: d.team_id ?? null, tags: d.tags ?? [] });
const sourceHash = () => {
  const root = arg('--runtime-build', 'src')!;
  const paths = ['scripts/evaluate-rag.ts', 'src/evaluation/rag-evaluation.ts', 'src/evaluation/evidence.ts', 'package-lock.json', ...readdirSync(root, { recursive: true })
    .map(String).filter(path => path.endsWith(root === 'src' ? '.ts' : '.js')).map(path => resolve(root, path))].sort();
  return fingerprint(paths.map(path => ({ path, content: readFileSync(path, 'utf8') })));
};

async function main() {
  const evalRoot = resolve(arg('--eval-root', 'evals')!);
  const corpus = jsonl(resolve(arg('--corpus', resolve(evalRoot, 'rag_corpus.jsonl'))!));
  const allCases = jsonl(resolve(arg('--dataset', resolve(evalRoot, 'rag_cases.jsonl'))!));
  validateAssets(corpus, allCases);
  const chunkManifestPath = arg('--chunk-manifest');
  const endToEnd = flag('--end-to-end');
  const chunkManifest: Json | undefined = chunkManifestPath ? JSON.parse(readFileSync(chunkManifestPath, 'utf8')) : undefined;
  if (chunkManifest) {
    validateRetrievalLabels(corpus, allCases, chunkManifest);
    if (chunkManifest.corpus_sha256 !== fingerprint(corpus.map(identity)) || chunkManifest.dataset_sha256 !== fingerprint(allCases))
      throw new Error('分块清单与冻结语料或题集不符，请重新核验标注');
  }
  const limit = Number(arg('--limit', String(allCases.length)));
  const topK = Number(arg('--top-k', chunkManifest && !endToEnd ? '3' : '5'));
  const mode = arg('--mode', 'hybrid')!;
  const concurrency = Number(arg('--concurrency', '1'));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('concurrency必须在1至3之间');
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(topK) || topK < 1 || topK > 50 || !['keyword', 'dense', 'hybrid'].includes(mode)) throw new Error('limit/top-k/mode 参数无效');
  if (chunkManifest && !endToEnd && (!flag('--retrieval-only') || topK !== 3)) throw new Error('固定分块回归要求 retrieval-only / top-k=3');
  if (endToEnd && (!chunkManifest || flag('--retrieval-only'))) throw new Error('端到端评测要求分块清单且不能是 retrieval-only');
  const selected = arg('--case-ids')?.split(',');
  if (selected?.some(id => !allCases.some(c => c.case_id === id))) throw new Error('case-ids 含未知问题');
  const cases = allCases.filter(c => !selected || selected.includes(c.case_id)).slice(0, limit);
  if (flag('--validate-only')) { console.log(JSON.stringify({ status: 'valid', corpus_documents: corpus.length, cases: cases.length })); return; }
  if (!flag('--retrieval-only') && (mode !== 'hybrid' || topK !== 5)) throw new Error('回答链路固定 hybrid/top_k=5；比较其他检索模式请使用 --retrieval-only，不能冒充回答配置');
  const baseUrl = arg('--base-url', process.env.RAG_API_BASE_URL ?? 'http://127.0.0.1:8001')!.replace(/\/$/u, '');
  const runDir = resolve(arg('--run-dir', resolve(arg('--output-dir', 'evals/results')!, new Date().toISOString().replace(/[:.]/gu, '-')))!);
  mkdirSync(runDir, { recursive: true });
  const auths = new Map<string, Record<string, string>>();
  async function request(path: string, init: RequestInit = {}) {
    const started = performance.now();
    const response = await fetch(baseUrl + path, { ...init, signal: AbortSignal.timeout(120000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${response.status}`); }
    return { body: await response.json() as Json, latency: Math.round(performance.now() - started) };
  }
  const metadataPath = resolve(runDir, 'metadata.json');
  const checkpointPath = resolve(runDir, 'checkpoint.json');
  const options = { base_url: baseUrl, top_k: topK, mode, retrieval_only: flag('--retrieval-only'), case_ids: cases.map(c => c.case_id),
    ...(arg('--runtime-build') ? { runtime_build: resolve(arg('--runtime-build')!), concurrency } : concurrency !== 1 ? { concurrency } : {}),
    ...(chunkManifest ? { expand_query: false, rerank: !flag('--no-rerank'), candidate_k: 20, end_to_end: endToEnd } : {}) };
  const protocol = { version: chunkManifest ? 3 : 2, dataset_sha256: fingerprint(allCases), corpus_sha256: fingerprint(corpus.map(identity)),
    source_sha256: sourceHash(), options, ...(chunkManifest ? { chunk_manifest_sha256: fingerprint(chunkManifest), dataset_version: chunkManifest.dataset_version } : {}) };
  let commit = 'unknown'; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* git optional */ }
  const health = (await request('/health')).body;
  for (const [key, value] of Object.entries({ runtime_mode: 'real', metadata_store: 'mysql', vector_store: 'qdrant', embedding_provider: 'transformers', sparse_embedding_provider: 'qdrant_idf', rerank_provider: 'bge', agent_tool_selection: 'llm' }))
    if (health[key] !== value) throw new Error(`真实环境预检失败：${key}`);
  if (!health.llm_configured) throw new Error('模型未配置');
  if (chunkManifest && (chunkManifest.chunking.max_tokens !== health.chunk_max_tokens || chunkManifest.chunking.overlap_tokens !== health.chunk_overlap_tokens
    || chunkManifest.chunking.embedding_model !== health.embedding_model)) throw new Error('线上分块配置与冻结分块清单不符');
  const environment = { config_fingerprint: health.config_fingerprint, collection: health.collection, llm_model: health.llm_model,
    embedding_provider: health.embedding_provider, rerank_provider: health.rerank_provider,
    embedding_model: health.embedding_model, rerank_model: health.rerank_model, rerank_top_n: health.rerank_top_n,
    node_version: process.version };
  const metadata: Json = { ...protocol, git_commit: commit, environment, started_at: new Date().toISOString(), corpus_before: [] };
  const previous = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) as Json : undefined;
  if (previous && (fingerprint(previous.options) !== fingerprint(options) || previous.dataset_sha256 !== protocol.dataset_sha256
    || previous.corpus_sha256 !== protocol.corpus_sha256 || previous.source_sha256 !== protocol.source_sha256
    || previous.chunk_manifest_sha256 !== protocol.chunk_manifest_sha256
    || fingerprint(previous.environment) !== fingerprint(environment))) throw new Error('题集、语料、配置、选项或源码变化，请使用新的 run-dir');
  if (previous && flag('--seed-eval')) throw new Error('续跑不能重新播种语料');
  const rows: Json[] = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) : [];
  if (!previous && rows.length) throw new Error('缺少运行元数据，拒绝复用检查点');
  try {
    for (const email of new Set([...corpus.map(d => d.owner_email), ...cases.map(c => c.identity)])) {
      const { body } = await request('/dev/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: process.env.RAG_EVAL_PASSWORD ?? 'Demo@123456' }) });
      auths.set(email, { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' });
    }
    if (flag('--seed-eval')) {
      if (corpus.some(d => !/^eval_[\w-]+$/u.test(d.doc_id))) throw new Error('自动播种仅允许 eval_ 前缀文档 ID');
      const jobs: Array<{ id: string; owner: string }> = [];
      for (const doc of corpus) {
        const headers = auths.get(doc.owner_email)!;
        const response = await fetch(baseUrl + '/documents/' + encodeURIComponent(doc.doc_id), { headers, signal: AbortSignal.timeout(15000) });
        let live: Json;
        if (response.status === 404) {
          const { owner_email, sha256, ...input } = doc;
          live = (await request('/documents', { method: 'POST', headers, body: JSON.stringify({ ...input, index_now: true }) })).body;
        } else {
          if (!response.ok) throw new Error(`无法核验测试文档：${doc.doc_id}`);
          live = await response.json() as Json;
          if (fingerprint(identity(live)) !== fingerprint(identity(doc))) throw new Error(`已存在同 ID 不同内容，拒绝覆盖：${doc.doc_id}`);
          if (live.index_status !== 'ready' || live.active_index_version !== live.document_version)
            live = (await request(`/documents/${doc.doc_id}/reindex`, { method: 'POST', headers })).body;
        }
        if (live.job_id || live.latest_index_job_id) jobs.push({ id: live.job_id ?? live.latest_index_job_id, owner: doc.owner_email });
      }
      const deadline = Date.now() + Number(arg('--wait-timeout', '900000'));
      while (jobs.length) {
        if (Date.now() >= deadline) throw new Error('测试文档索引等待超时');
        for (let i = jobs.length - 1; i >= 0; i--) {
          const j = jobs[i]!; const { body } = await request('/index-jobs/' + j.id, { headers: auths.get(j.owner) });
          if (body.status === 'succeeded') jobs.splice(i, 1);
          else if (['failed', 'superseded', 'canceled'].includes(body.status)) throw new Error(`索引任务 ${j.id} 结束为 ${body.status}`);
        }
        if (jobs.length) await new Promise(r => setTimeout(r, 1000));
      }
    }
    async function verifyCorpus() {
      const snapshots: Json[] = [];
      for (const doc of corpus) {
        const { body } = await request('/documents/' + encodeURIComponent(doc.doc_id), { headers: auths.get(doc.owner_email) });
        if (fingerprint(identity(body)) !== fingerprint(identity(doc))) throw new Error(`冻结语料与线上不符：${doc.doc_id}，请检查内容或显式播种测试资料`);
        if (body.index_status !== 'ready' || body.active_index_version !== body.document_version) throw new Error(`测试文档不是当前有效索引：${doc.doc_id}`);
        snapshots.push({ doc_id: doc.doc_id, content_sha256: fingerprint(identity(body)), version: body.document_version, index_version: body.active_index_version });
      }
      return snapshots;
    }
    metadata.corpus_before = await verifyCorpus();
    if (previous && fingerprint(previous.corpus_before) !== fingerprint(metadata.corpus_before)) throw new Error('线上语料版本发生变化，不能续跑');
    if (!previous) save(metadataPath, metadata);
    const metadataInUse = previous ?? metadata;
    let environmentError: string | undefined;
    try {
      const evaluateCase = async (c: Json) => {
        const prior = rows.find(r => r.case_id === c.case_id);
        if (prior && !['in_flight', 'error'].includes(prior.status)) return;
        if (prior && !flag('--retry-errors')) {
          console.log(JSON.stringify({ case_id: c.case_id, skipped: prior.status, action: '检查失败或中断请求后，可显式 --retry-errors' })); return;
        }
        const row: Json = { ...c, status: 'in_flight', started_at: new Date().toISOString(), search: null, answer: null };
        if (prior) rows.splice(rows.indexOf(prior), 1);
        rows.push(row); save(checkpointPath, rows);
        const scope = { ...c.scope, document_ids: corpus.map(d => d.doc_id) };
        const headers = auths.get(c.identity)!;
        try {
          const search = await request('/knowledge/search', { method: 'POST', headers,
            body: JSON.stringify({ query: c.query, scope, top_k: topK, mode,
              ...(chunkManifest ? { include_retrieval_debug: true, expand_query: false, rerank: options.rerank } : {}) }) });
          row.search = search.body; row.search_latency_ms = search.latency;
          if (chunkManifest) {
            const debug = row.search.retrieval_debug;
            if (!debug) throw new Error('缺少候选池快照，请先升级后端');
            for (const hit of [...debug.candidates, ...debug.ranked]) {
              const frozen = chunkManifest.chunks.find((chunk: Json) => chunk.chunk_id === hit.chunk_id);
              const version = metadata.corpus_before.find((doc: Json) => doc.doc_id === hit.doc_id)?.version;
              if (!frozen || frozen.doc_id !== hit.doc_id || frozen.content !== (hit.source_content ?? hit.content) || hit.document_version !== version)
                throw new Error(`返回分块与冻结内容或版本不符：${hit.chunk_id}`);
            }
            if (row.search.trace.expansion_enabled) throw new Error('固定检索回归不得启用查询扩展');
            row.retrieval_grade = gradeRetrieval(c, row.search);
          }
          save(checkpointPath, rows);
          if (!options.retrieval_only) {
            const domain = c.scope.team ? 'team' : c.scope.private ? 'private' : 'public';
            const answer = await request('/ai/write', { method: 'POST', headers, body: JSON.stringify({ intent: 'knowledge_qa', query: c.query,
              current_context: { title: '隔离语料评测' }, scope, retrieval_domain: domain, stream: false, include_evidence: true }) });
            row.answer = answer.body; row.answer_latency_ms = answer.latency;
            if (!row.answer.evidence_snapshot) throw new Error('回答接口未返回实际证据快照，请先升级后端');
            if (endToEnd && !row.answer.evidence_snapshot.retrieval_debug) throw new Error('缺少本轮回答自身的检索快照，不能使用独立搜索冒充');
          }
          row.status = options.retrieval_only ? 'retrieval_only' : 'completed';
        } catch (error) { row.status = 'error'; row.error = error instanceof Error ? error.message : String(error); }
        row.grade = gradeCase(c, row.search, row.answer); row.finished_at = new Date().toISOString(); save(checkpointPath, rows);
        console.log(JSON.stringify({ case_id: c.case_id, status: row.status, context_paired: row.grade.context_paired, error: row.error }));
      };
      for (let start = 0; start < cases.length; start += concurrency) await Promise.all(cases.slice(start, start + concurrency).map(evaluateCase));
    } finally {
      try {
        const after = (await request('/health')).body;
        if (sourceHash() !== protocol.source_sha256) throw new Error('运行期间本地源码发生变化');
        if (after.config_fingerprint !== health.config_fingerprint || after.collection !== health.collection) throw new Error('运行期间配置发生变化');
        if (fingerprint(await verifyCorpus()) !== fingerprint(metadata.corpus_before)) throw new Error('运行期间语料或索引版本变化');
      } catch (error) { environmentError = error instanceof Error ? error.message : String(error); }
      for (const row of rows) if (!row.grade) row.grade = gradeCase(row, row.search, row.answer);
      const report = { ...metadataInUse, finished_at: new Date().toISOString(), valid: !environmentError && rows.every(r => r.status !== 'in_flight'),
        environment_error: environmentError, metrics: summarize(rows, topK, options.retrieval_only), cases: rows };
      save(resolve(runDir, 'report.json'), report);
      writeFileSync(resolve(runDir, 'cases.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      if (chunkManifest) {
        save(resolve(runDir, 'chunks.json'), chunkManifest);
        const failures = rows.filter(r => r.error || r.grade.permission_leak || (r.retrieval_grade?.recall_at_3 != null &&
          (r.retrieval_grade.recall_at_3 < 1 || r.retrieval_grade.candidate_recall_at_20 < 1 || !r.retrieval_grade.evidence_at_3.all)));
        writeFileSync(resolve(runDir, 'failed_cases.jsonl'), failures.map(r => JSON.stringify(r)).join('\n') + (failures.length ? '\n' : ''));
      }
      writeFileSync(resolve(runDir, 'review.csv'), 'case_id,category,auto_verdict,human_verdict,reviewer,notes\n' + rows.filter(r => r.answer).map(r => `${r.case_id},${r.category ?? ''},${r.grade.verdict},pending,,`).join('\n') + '\n');
      writeFileSync(resolve(runDir, 'summary.md'), `# LiveDoc 固定语料评测\n\n有效运行：${report.valid}。${environmentError ?? ''}\n\n\`\`\`json\n${JSON.stringify(report.metrics, null, 2)}\n\`\`\`\n\n检索摘录与实际注入证据分开计分。关键词命中、引用结构有效均不代表答案语义正确；answer_correctness 保持空值，见 review.csv 人工复核。检索失败和模型失败单独统计，缺少标注的指标为空。测试资料及候选结果请勿当作真实质量承诺。\n`);
      console.log(JSON.stringify({ run_dir: runDir, valid: report.valid, metrics: report.metrics }, null, 2));
      if (!report.valid || report.metrics.error_count || (report.metrics.permission_leak_rate ?? 0) > 0 || (!options.retrieval_only && report.metrics.citation_validity !== 1)) process.exitCode = 2;
    }
  } finally {
    await Promise.allSettled([...auths.values()].map(headers => fetch(baseUrl + '/dev/auth/logout', { method: 'POST', headers, signal: AbortSignal.timeout(10000) })));
  }
}
await main();
