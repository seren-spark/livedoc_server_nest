import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfig } from '../src/config/app-config.js';
import { InferenceWorkerService } from '../src/inference/inference-worker.service.js';
import { RerankerService } from '../src/inference/reranker.service.js';
import { fingerprint, mean, pairedBootstrap, scoreGradedRanking, type Json } from '../src/evaluation/rag-evaluation.js';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]!; };
const suite: Json = JSON.parse(readFileSync(arg('--dataset', 'evals/rerank_cases.json'), 'utf8').replace(/^\uFEFF/u, ''));
const config = new AppConfig();
if (config.runtimeMode !== 'real' || config.rerankProvider !== 'bge') throw new Error('重排评测要求真实 bge 后端，不允许启发式回退');
const k = Number(arg('--top-k', '3'));
if (!Number.isInteger(k) || k < 1 || !suite.version || !suite.cases?.length) throw new Error('数据集或 top-k 无效');
const ids = new Set();
for (const c of suite.cases) {
  if (!c.id || ids.has(c.id) || !c.query || c.items.some((item: Json) => !item.text || !item.title)) throw new Error('重排题集字段无效');
  ids.add(c.id); scoreGradedRanking(c.items, c.items.map((i: Json) => i.id), k);
}
const dir = resolve(arg('--run-dir', 'evals/results/rerank-' + new Date().toISOString().replace(/[:.]/gu, '-')));
mkdirSync(dir, { recursive: true });
const path = resolve(dir, 'report.json');
const metadata = { suite_sha256: fingerprint(suite), model: config.rerankModel, dtype: config.modelDtype, top_k: k,
  source_sha256: fingerprint(['scripts/evaluate-rerank.ts', 'src/evaluation/rag-evaluation.ts', 'src/inference/reranker.service.ts', 'src/inference/inference.worker.ts', 'src/inference/inference-worker.service.ts'].map(p => readFileSync(p, 'utf8'))) };
const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Json : undefined;
if (prior && fingerprint(prior.metadata) !== fingerprint(metadata)) throw new Error('题集、模型或实现变化，请使用新的 run-dir');
const trials: Json[] = prior?.trials ?? [];
const worker = new InferenceWorkerService(config), reranker = new RerankerService(config, worker);
const persist = (summary: Json = {}) => { writeFileSync(path + '.tmp', JSON.stringify({ metadata, trials, summary }, null, 2)); renameSync(path + '.tmp', path); };
let warmed = false;
try {
  for (const c of suite.cases) for (let permutation = 0; permutation < 2; permutation++) {
    if (trials.some(r => r.case_id === c.id && r.permutation === permutation)) continue;
    const items: Json[] = permutation ? [...c.items].reverse() : c.items;
    // Gold labels never enter the real production reranker.
    const hits = items.map((item, index) => ({ pointId: item.id, score: 1 / (index + 1), payload: { title: item.title, content: item.text } }));
    if (!warmed) { await reranker.rerank(c.query, hits.slice(0, 1), 1); warmed = true; }
    const row: Json = { case_id: c.id, permutation, input_sha256: fingerprint({ query: c.query, hits }), input_order: hits.map(h => h.pointId) };
    const started = performance.now();
    try {
      const ranked = await reranker.rerank(c.query, hits, hits.length);
      row.order = ranked.map(h => h.pointId); row.elapsed_ms = Math.round(performance.now() - started);
      row.baseline = scoreGradedRanking(c.items, row.input_order, k); row.candidate = scoreGradedRanking(c.items, row.order, k);
      row.status = 'completed';
    } catch (error) {
      row.status = 'error'; row.error = error instanceof Error ? error.message : String(error);
      trials.push(row); persist(); throw new Error('真实重排失败，诊断已保存；不回退另一模型或原排序冒充成功');
    }
    trials.push(row); persist(); console.log(JSON.stringify({ case_id: c.id, permutation, ndcg: row.candidate.ndcg }));
  }
  const paired = suite.cases.map((c: Json) => {
    const rows = trials.filter(r => r.case_id === c.id && r.status === 'completed');
    return rows.length === 2 ? { case_id: c.id, baseline: mean(rows.map(r => r.baseline.ndcg)), candidate: mean(rows.map(r => r.candidate.ndcg)),
      difference: mean(rows.map(r => r.candidate.ndcg - r.baseline.ndcg))! } : null;
  }).filter(Boolean);
  const summary = { questions: paired.length, completed_trials: trials.filter(r => r.status === 'completed').length,
    failed_trials: trials.filter(r => r.status !== 'completed').length, baseline_ndcg_at_k: mean(paired.map((p: Json) => p.baseline)),
    candidate_ndcg_at_k: mean(paired.map((p: Json) => p.candidate)), candidate_minus_baseline: pairedBootstrap(paired.map((p: Json) => p.difference)),
    limitation: '固定合成候选原序与真实 BGE 重排比较；不是线上 RRF 基线，不评价召回或答案正确率。两种排列先按问题平均，再 bootstrap。' };
  persist(summary);
  writeFileSync(resolve(dir, 'summary.md'), '# 固定候选重排评测\n\n```json\n' + JSON.stringify(summary, null, 2) + '\n```\n\n' + summary.limitation + '\n');
  console.log(JSON.stringify({ run_dir: dir, summary }, null, 2));
  if (summary.failed_trials) process.exitCode = 2;
} finally { await worker.onModuleDestroy(); }
