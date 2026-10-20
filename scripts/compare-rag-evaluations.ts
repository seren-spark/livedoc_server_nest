import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fingerprint, pairedBootstrap, rankingMetrics, type Json } from '../src/evaluation/rag-evaluation.js';

const arg = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
if (!arg('--baseline') || !arg('--candidate')) throw new Error('需要 --baseline 和 --candidate 两份 report.json');
const a: Json = JSON.parse(readFileSync(resolve(arg('--baseline')!), 'utf8'));
const b: Json = JSON.parse(readFileSync(resolve(arg('--candidate')!), 'utf8'));
for (const key of ['dataset_sha256', 'corpus_sha256'])
  if (!a[key] || a[key] !== b[key]) throw new Error(`不能比较不同冻结题集或语料：${key}`);
if (a.chunk_manifest_sha256 !== b.chunk_manifest_sha256 || a.options.candidate_k !== b.options.candidate_k
  || a.options.expand_query !== b.options.expand_query) throw new Error('分块标注、候选池大小或查询扩展配置不同，拒绝配对');
if (fingerprint(a.corpus_before) !== fingerprint(b.corpus_before) || fingerprint(a.options.case_ids) !== fingerprint(b.options.case_ids)
  || a.options.top_k !== b.options.top_k || a.options.retrieval_only !== b.options.retrieval_only)
  throw new Error('文档版本、问题范围、top-k 或评测阶段不同，拒绝配对');
if (!a.valid || !b.valid) throw new Error('不能比较环境漂移或中断未完成的报告');
const pairs = a.cases.map((x: Json) => ({ a: x, b: b.cases.find((y: Json) => x.case_id === y.case_id) }));
if (pairs.some((p: Json) => !p.b)) throw new Error('报告缺少对应问题');
const hasSearch = (p: Json) => p.a.search && p.b.search && (!a.chunk_manifest_sha256 || (p.a.retrieval_grade && p.b.retrieval_grade));
const comparable = pairs.filter((p: Json) => hasSearch(p) && p.a.relevant_doc_ids?.length);
const metrics = Object.fromEntries(['recall', 'mrr', 'ndcg'].map(metric => {
  const differences = comparable.map((p: Json) => {
    const score = (r: Json) => rankingMetrics(r.relevant_doc_ids, r.grade.returned_doc_ids, a.options.top_k)[metric as 'recall']!;
    return score(p.b) - score(p.a);
  });
  return [metric, pairedBootstrap(differences)];
}));
if (a.chunk_manifest_sha256) {
  for (const key of ['recall', 'mrr', 'ndcg']) delete metrics[key];
  for (const metric of ['recall_at_3', 'mrr_at_3', 'ndcg_at_3', 'candidate_recall_at_20', 'evidence_group_recall_at_3']) {
    const valid = pairs.filter((p: Json) => p.a.retrieval_grade?.recall_at_3 != null && p.b.retrieval_grade?.recall_at_3 != null);
    metrics[metric] = pairedBootstrap(valid.map((p: Json) => {
      const score = (r: Json) => metric === 'evidence_group_recall_at_3' ? r.retrieval_grade.evidence_at_3.recall : r.retrieval_grade[metric];
      return score(p.b) - score(p.a);
    }));
  }
}
const output = { direction: 'candidate_minus_baseline', question_count: pairs.length, paired_retrieval_questions: comparable.length,
  excluded_pairs: pairs.filter((p: Json) => !hasSearch(p)).map((p: Json) => p.a.case_id),
  baseline_errors: a.metrics.error_count, candidate_errors: b.metrics.error_count, metrics,
  baseline_environment: a.environment, candidate_environment: b.environment,
  ...(a.chunk_manifest_sha256 ? { chunk_manifest_sha256: a.chunk_manifest_sha256, dataset_version: a.dataset_version } : {}),
  source_changed: a.source_sha256 !== b.source_sha256, baseline_options: a.options, candidate_options: b.options,
  limitation: '同题配对 bootstrap 仅比较已标注问题的检索结果，不等于答案正确率；失败配对单列，不静默删除。' };
const path = resolve(arg('--output') ?? 'evals/results/comparison.json');
writeFileSync(path, JSON.stringify(output, null, 2) + '\n');
writeFileSync(path.replace(/\.json$/u, '') + '.md', `# RAG 配对比较\n\n差值方向：候选 − 基线。${output.question_count} 题，${output.paired_retrieval_questions} 个有标注且检索成功的配对。\n\n| 指标 | 均值差 | 95% 区间 |\n| --- | --- | --- |\n${Object.entries(metrics).map(([key, value]) => `| ${key} | ${(value as Json).delta ?? '无标注'} | ${JSON.stringify((value as Json).ci95)} |`).join('\n')}\n\n失败配对：${output.excluded_pairs.join(', ') || '无'}。\n\n${output.limitation}\n`);
console.log(JSON.stringify({ output: path, ...output }, null, 2));
