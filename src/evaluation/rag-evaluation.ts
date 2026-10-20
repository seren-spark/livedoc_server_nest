import { sha256 } from './evidence.js';

export type Json = Record<string, any>;
export const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
export const fingerprint = (value: any) => sha256(canonical(value));
const normalize = (text: any) => String(text ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
export const mean = (values: Array<number | null | undefined>) => {
  const valid = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
};
export function percentile(values: number[], q: number) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)]! : null;
}

export function validateAssets(corpus: Json[], cases: Json[]) {
  if (!corpus.length || !cases.length) throw new Error('语料与题集不能为空');
  const docs = new Map<string, Json>(), ids = new Set<string>();
  for (const doc of corpus) {
    if (!doc.doc_id || docs.has(doc.doc_id) || typeof doc.content !== 'string' || !doc.owner_email)
      throw new Error(`语料 ID 重复或内容无效：${doc.doc_id}`);
    if (doc.sha256 && sha256(doc.content) !== doc.sha256) throw new Error(`语料哈希不符：${doc.doc_id}`);
    docs.set(doc.doc_id, doc);
  }
  for (const c of cases) {
    if (!/^[\w-]+$/u.test(c.case_id ?? '') || ids.has(c.case_id) || !c.query?.trim() || !c.identity || !c.scope)
      throw new Error(`问题 ID 重复或字段无效：${c.case_id}`);
    ids.add(c.case_id);
    if (c.expected_behavior && !['answer', 'abstain', 'clarify'].includes(c.expected_behavior)) throw new Error(`无效行为：${c.case_id}`);
    for (const id of [...(c.relevant_doc_ids ?? []), ...(c.forbidden_doc_ids ?? [])])
      if (!docs.has(id)) throw new Error(`未知原文：${c.case_id}/${id}`);
    for (const group of c.evidence_groups ?? []) {
      if (!group.id || !group.alternatives?.length) throw new Error(`证据组不能为空：${c.case_id}`);
      for (const alt of group.alternatives) {
        const doc = docs.get(alt.doc_id);
        if (!doc) throw new Error(`未知证据原文：${alt.doc_id}`);
        if (!alt.quotes?.length || alt.quotes.some((q: any) => typeof q !== 'string' || !normalize(q) || !normalize(doc.content).includes(normalize(q))))
          throw new Error(`证据摘录必须来自冻结原文：${c.case_id}/${group.id}`);
      }
    }
  }
}

export function scoreEvidence(groups: Json[], citations: Json[], quotes = false) {
  if (!groups.length) return { all: null, recall: null, groups: [] };
  const byDoc = new Map<string, string[]>();
  for (const c of citations) byDoc.set(c.doc_id, [...(byDoc.get(c.doc_id) ?? []), normalize(c.content)]);
  const rows = groups.map(g => ({ id: g.id, hit: g.alternatives.some((a: Json) => {
    const texts = byDoc.get(a.doc_id);
    return texts && (!quotes || (a.quotes?.length && a.quotes.every((q: string) => texts.some(t => t.includes(normalize(q))))));
  }) }));
  return { all: rows.every(r => r.hit), recall: rows.filter(r => r.hit).length / rows.length, groups: rows };
}

export function rankingMetrics(expected: string[], returned: string[], k: number) {
  if (!expected.length) return { recall: null, mrr: null, ndcg: null };
  const relevant = new Set(expected), ranked = returned.slice(0, k), seen = new Set<string>();
  const dcg = ranked.reduce((sum, id, i) => {
    const gain = relevant.has(id) && !seen.has(id); seen.add(id);
    return sum + (gain ? 1 / Math.log2(i + 2) : 0);
  }, 0);
  const ideal = Array.from({ length: Math.min(relevant.size, k) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  const rank = ranked.findIndex(id => relevant.has(id));
  return { recall: new Set(ranked.filter(id => relevant.has(id))).size / relevant.size,
    mrr: rank < 0 ? 0 : 1 / (rank + 1), ndcg: dcg / ideal };
}

export function validateRetrievalLabels(corpus: Json[], cases: Json[], manifest: Json) {
  const chunks = new Map<string, Json>(manifest.chunks.map((c: Json) => [c.chunk_id, c]));
  if (chunks.size !== manifest.chunks.length || !chunks.size) throw new Error('分块 ID 重复或为空');
  const docs = new Map(corpus.map(d => [d.doc_id, d]));
  for (const chunk of chunks.values()) {
    const doc = docs.get(chunk.doc_id);
    if (!doc || doc.content.slice(chunk.start_offset, chunk.end_offset) !== chunk.content) throw new Error(`分块与冻结原文不符：${chunk.chunk_id}`);
  }
  for (const c of cases) {
    if (!c.annotation_version || !Array.isArray(c.chunk_qrels) || !Array.isArray(c.evidence_groups)) throw new Error(`缺少分块或证据标注：${c.case_id}`);
    const positives = c.chunk_qrels.filter((q: Json) => q.score > 0);
    if (new Set(c.chunk_qrels.map((q: Json) => q.chunk_id)).size !== c.chunk_qrels.length
      || c.chunk_qrels.some((q: Json) => !chunks.has(q.chunk_id) || ![0, 1, 2, 3].includes(q.score))) throw new Error(`无效分块标注：${c.case_id}`);
    if (c.relevant_doc_ids?.length) {
      if (!positives.length || !c.evidence_groups.length) throw new Error(`可回答问题缺少正例证据：${c.case_id}`);
      if (fingerprint([...new Set(positives.map((q: Json) => chunks.get(q.chunk_id)!.doc_id))].sort()) !== fingerprint([...c.relevant_doc_ids].sort()))
        throw new Error(`分块与相关文档不符：${c.case_id}`);
      for (const group of c.evidence_groups) {
        if (!group.alternatives.some((a: Json) => a.quotes.every((quote: string) => positives.some((q: Json) => {
          const chunk = chunks.get(q.chunk_id)!;
          return chunk.doc_id === a.doc_id && normalize(chunk.content).includes(normalize(quote));
        })))) throw new Error(`分块没有覆盖必要证据：${c.case_id}/${group.id}`);
      }
    } else if (positives.length || c.evidence_groups.length || c.expected_behavior !== 'abstain') throw new Error(`无授权证据问题不能伪造正例：${c.case_id}`);
  }
}

export function gradeRetrieval(c: Json, search: Json | null) {
  const debug = search?.retrieval_debug;
  if (debug?.schema_version !== 1 || debug.candidate_stage !== 'authorized_fused_before_rerank'
    || debug.candidate_limit !== 20 || !Array.isArray(debug.candidates) || !Array.isArray(debug.ranked))
    throw new Error('缺少重排前候选池或压缩前排名快照，请升级后端');
  const relevant = c.chunk_qrels.filter((q: Json) => q.score > 0).map((q: Json) => q.chunk_id);
  const score = chunkRankingMetrics(c.chunk_qrels, debug.ranked.map((x: Json) => x.chunk_id), 3);
  return { recall_at_3: score.recall, mrr_at_3: score.mrr, ndcg_at_3: score.ndcg,
    candidate_recall_at_20: rankingMetrics(relevant, debug.candidates.map((x: Json) => x.chunk_id), 20).recall,
    evidence_at_3: scoreEvidence(c.evidence_groups, debug.ranked.slice(0, 3), true),
    candidate_count: debug.candidates.length,
    candidate_chunk_ids: debug.candidates.map((x: Json) => x.chunk_id),
    ranked_chunk_ids: debug.ranked.map((x: Json) => x.chunk_id),
    no_authorized_evidence: !relevant.length };
}

export function chunkRankingMetrics(qrels: Json[], returned: string[], k: number) {
  const positive = qrels.filter(q => q.score > 0), grades = new Map(positive.map(q => [q.chunk_id, q.score]));
  const score = rankingMetrics(positive.map(q => q.chunk_id), returned, k);
  if (!positive.length) return score;
  const seen = new Set<string>();
  const dcg = returned.slice(0, k).reduce((sum, id, i) => {
    const grade = seen.has(id) ? 0 : grades.get(id) ?? 0; seen.add(id);
    return sum + (2 ** grade - 1) / Math.log2(i + 2);
  }, 0);
  const ideal = positive.map(q => q.score).sort((a, b) => b - a).slice(0, k)
    .reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
  return { ...score, ndcg: dcg / ideal };
}

export function gradeCase(c: Json, search: Json | null, answer: Json | null) {
  const retrieved: Json[] = search?.citations ?? [], cited: Json[] = answer?.citations ?? [];
  const snapshot = answer?.evidence_snapshot;
  const injected: Json[] | null = snapshot?.schema_version === 1 && snapshot.trace_id === answer?.trace?.trace_id
    && snapshot.evidence_sha256 === sha256(JSON.stringify((snapshot.citations ?? []).map(({ index, citation_id, title, heading_path, document_version, content }: Json) =>
      ({ index, citation_id, title, heading_path, document_version, content })))) ? snapshot.citations : null;
  const groups = c.evidence_groups ?? (c.relevant_doc_ids ?? []).map((id: string) => ({ id, alternatives: [{ doc_id: id }] }));
  const returnedIds = retrieved.map(x => x.doc_id);
  const forbidden = new Set(c.forbidden_doc_ids ?? []);
  const leaked = [...new Set([...returnedIds, ...cited.map(x => x.doc_id), ...(injected ?? []).map(x => x.doc_id),
    ...(search?.retrieval_debug?.candidates ?? []).map((x: Json) => x.doc_id),
    ...(snapshot?.retrieval_debug?.candidates ?? []).map((x: Json) => x.doc_id),
    ...(snapshot?.retrieval_debug?.ranked ?? []).map((x: Json) => x.doc_id)])].filter(id => forbidden.has(id));
  const text = normalize(answer?.answer);
  const facts = (c.required_facts ?? []).map((alternatives: string[]) => alternatives.some(f => text.includes(normalize(f))));
  const factHits: string[] = answer ? (c.forbidden_facts ?? []).filter((f: string) => text.includes(normalize(f))) : [];
  const questionEchoes = factHits.filter(f => normalize(c.query).includes(normalize(f)));
  // A word already supplied by the user cannot prove disclosure; semantic behavior still needs review.
  const forbiddenFacts = factHits.filter(f => !questionEchoes.includes(f));
  const behavior = c.expected_behavior ?? (c.expected_refusal ? 'abstain' : 'answer');
  const refused = answer ? /未查询到相关依据|无法作答/u.test(answer.answer ?? '') : null;
  const references = [...String(answer?.answer ?? '').matchAll(/\[(\d+)\]/gu)].map(m => Number(m[1]));
  const indexes = new Set(cited.map(x => x.index));
  const citationValid = !answer ? null : refused ? Number(!references.length && !cited.length)
    : Number(cited.length > 0 && references.length > 0 && indexes.size === cited.length
      && new Set(cited.map(x => x.citation_id)).size === cited.length
      && cited.every(x => x.citation_id && x.doc_id && x.chunk_id && x.document_version && x.source_anchor)
      && references.every(index => indexes.has(index)));
  const permissionLeak = search || answer ? Boolean(leaked.length || forbiddenFacts.length) : null;
  return {
    returned_doc_ids: returnedIds,
    retrieval_sources: search ? scoreEvidence(groups, retrieved) : null,
    retrieval_quotes: search && c.evidence_groups ? scoreEvidence(c.evidence_groups, retrieved, true) : null,
    injected_sources: injected ? scoreEvidence(groups, injected) : null,
    injected_quotes: injected && c.evidence_groups ? scoreEvidence(c.evidence_groups, injected, true) : null,
    context_paired: injected !== null, fact_pattern_coverage: answer && facts.length ? facts.filter(Boolean).length / facts.length : null,
    citation_validity: citationValid, expected_behavior: behavior, refused,
    behavior_pattern_match: answer && behavior !== 'clarify' ? Number((behavior === 'abstain') === refused) : null,
    permission_leak: permissionLeak, leaked_doc_ids: leaked, forbidden_fact_hits: forbiddenFacts, question_echo_fact_hits: questionEchoes,
    // Matching words and having citations are diagnostics, not semantic correctness.
    correctness: null, requires_human_review: Boolean(answer),
    verdict: permissionLeak || citationValid === 0 || (answer && behavior !== 'clarify' && (behavior === 'abstain') !== refused) ? 'fail' : answer ? 'review' : 'retrieval_only',
  };
}

export function summarize(results: Json[], topK: number, retrievalOnly = false) {
  const ranks = results.filter(r => r.search).map(r => rankingMetrics(r.relevant_doc_ids ?? [], r.grade.returned_doc_ids, topK));
  const grades = results.map(r => r.grade);
  const answers = results.filter(r => r.answer);
  return {
    ...(results.some(r => r.retrieval_grade) ? {
      retrieval_evaluated_questions: results.filter(r => r.retrieval_grade).length,
      chunk_labeled_questions: results.filter(r => r.chunk_qrels?.some((q: Json) => q.score > 0)).length,
      no_authorized_evidence_questions: results.filter(r => r.chunk_qrels?.length === 0).length,
      recall_at_3: mean(results.map(r => r.retrieval_grade?.recall_at_3)),
      mrr_at_3: mean(results.map(r => r.retrieval_grade?.mrr_at_3)),
      ndcg_at_3: mean(results.map(r => r.retrieval_grade?.ndcg_at_3)),
      candidate_recall_at_20: mean(results.map(r => r.retrieval_grade?.candidate_recall_at_20)),
      evidence_group_recall_at_3: mean(results.map(r => r.retrieval_grade?.evidence_at_3?.recall)),
      all_evidence_at_3_rate: mean(results.map(r => r.retrieval_grade?.evidence_at_3?.all == null ? null : Number(r.retrieval_grade.evidence_at_3.all))),
    } : {}),
    case_count: results.length, retrieval_count: results.filter(r => r.search).length, answer_count: answers.length,
    labeled_retrieval_questions: ranks.filter(r => r.recall !== null).length,
    annotated_quote_questions: grades.filter(g => g.retrieval_quotes?.recall !== null && g.retrieval_quotes?.recall !== undefined).length,
    model_call_count: answers.filter(r => r.answer.evidence_snapshot?.model_called).length,
    error_count: results.filter(r => r.error).length,
    recall_at_k: mean(ranks.map(r => r.recall)), mrr_at_k: mean(ranks.map(r => r.mrr)), ndcg_at_k: mean(ranks.map(r => r.ndcg)),
    retrieval_group_recall: mean(grades.map(g => g.retrieval_sources?.recall)),
    retrieval_quote_recall: mean(grades.map(g => g.retrieval_quotes?.recall)),
    injected_group_recall: mean(grades.map(g => g.injected_sources?.recall)),
    injected_quote_recall: mean(grades.map(g => g.injected_quotes?.recall)),
    paired_context_count: grades.filter(g => g.context_paired).length,
    fact_pattern_coverage: mean(grades.map(g => g.fact_pattern_coverage)), citation_validity: mean(grades.map(g => g.citation_validity)),
    behavior_pattern_match: mean(grades.map(g => g.behavior_pattern_match)),
    permission_leak_rate: mean(grades.map(g => g.permission_leak === null ? null : Number(g.permission_leak))),
    generation_success_rate: retrievalOnly ? null : results.length ? answers.length / results.length : null,
    answer_correctness: null, adoption_rate: null,
    search_p50_ms: percentile(results.filter(r => r.search).map(r => r.search_latency_ms), .5),
    search_p95_ms: percentile(results.filter(r => r.search).map(r => r.search_latency_ms), .95),
    answer_p50_ms: percentile(answers.map(r => r.answer_latency_ms), .5), answer_p95_ms: percentile(answers.map(r => r.answer_latency_ms), .95),
  };
}

// Resample whole questions, never treat multiple permutations of one question as independent.
export function pairedBootstrap(differences: number[], iterations = 2000, seed = 20261019) {
  if (!differences.length) return { delta: null, ci95: null, questions: 0 };
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const samples = Array.from({ length: iterations }, () => differences.reduce(sum => sum + differences[Math.floor(random() * differences.length)]!, 0) / differences.length);
  return { delta: mean(differences), ci95: [percentile(samples, .025), percentile(samples, .975)], questions: differences.length, iterations };
}

export function scoreGradedRanking(items: Json[], order: string[], k: number) {
  const labels = new Map(items.map(item => [item.id, item.relevance as number]));
  if (labels.size !== items.length || order.length !== items.length || new Set(order).size !== items.length || order.some(id => !labels.has(id))
    || items.some(item => ![0, 1, 2].includes(item.relevance)) || !items.some(item => item.relevance === 2))
    throw new Error('候选标签无效或重排结果不是完整排列');
  const dcg = (grades: number[]) => grades.slice(0, k).reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...labels.values()].sort((a, b) => b - a));
  const ranks = rankingMetrics(items.filter(item => item.relevance === 2).map(item => item.id), order, k);
  return { ...ranks, ndcg: dcg(order.map(id => labels.get(id)!)) / ideal, top1: Number(labels.get(order[0]!) === 2) };
}
