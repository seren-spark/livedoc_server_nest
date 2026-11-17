/**
 * @file 检索证据筛选。去除重复与重叠命中，平衡来源覆盖并限制最终证据数量。
 */
import type { SearchHit } from './vector-store.service.js';
import { tokenizeKeyword } from './text-utils.js';

const QUERY_FILLER = new Set([
  'the', 'a', 'an', 'what', 'which', 'who', 'how', 'does', 'is', 'are', 'of', 'for', 'to', 'in',
  'please', 'compare', 'explain', 'list', 'show', '分别', '比较', '对比', '查询', '资料', '文档',
  '信息', '项目', '知识库', '检索', '期间', '一次', '既要', '同时', '说明', '如何', '怎样', '哪些', '什么', '多少', '当前', '里面', '中的',
  '关于', '一下', '介绍', '原文', '根据', '需要', '是否', '可以', '保证', '还有',
]);

/**
 * 在不挤掉已有查询方面的前提下补充缺失证据，并控制返回数量。
 *
 *  Fill a missing explicit query facet without displacing an already covered facet.
 *
 * @param hits 向量库或关键词召回得到的候选命中。
 * @param query 用户问题或检索查询。
 * @param topK 最终保留的检索结果数量。
 * @returns 检索候选命中列表。
 */
export function selectEvidence(hits: SearchHit[], query: string, topK: number): SearchHit[] {
  const baseline = hits.slice(0, topK);
  if (topK < 2 || topK >= 20 || hits.length <= topK) return baseline;
  const clauses = query.split(/以及|并且|并能|又要|同时|分别|和|与|及|、|[；;？?]|\band\b/iu);
  if (clauses.length < 2 || clauses.length > 8) return baseline;
  const facets = clauses.map((clause) => [...new Set(tokenizeKeyword(clause))]
    .filter((term) => term.length > 1 && !QUERY_FILLER.has(term)).slice(0, 24))
    .filter((terms) => terms.length > 0);
  if (facets.length < 2) return baseline;

  // The existing relevance order is the boundary. Do not score an unbounded tail or require distinct documents.
  const pool = hits.slice(0, 20);
  const bodies = pool.map((hit) => new Set(tokenizeKeyword(
    String(hit.payload.source_content ?? hit.payload.content ?? '').slice(0, 12000),
  )));
  const frequencies = new Map<string, number>();
  for (const term of new Set(facets.flat()))
    frequencies.set(term, bodies.filter((body) => body.has(term)).length);
  const weights = facets.map((terms) => terms.map((term) =>
    1 + Math.log((pool.length + 1) / ((frequencies.get(term) ?? 0) + 1))));
  const matches = bodies.map((body) => facets.map((terms, facet) => {
    const total = weights[facet]!.reduce((sum, value) => sum + value, 0);
    const matched = terms.reduce((sum, term, index) => sum + (body.has(term) ? weights[facet]![index]! : 0), 0);
    return matched >= total * 0.75;
  }));
  const selected = baseline.map((_, index) => index);
  for (let facet = 0; facet < facets.length; facet++) {
    const covered = facets.map((_, index) => selected.some((hit) => matches[hit]![index]));
    if (covered[facet]) continue;
    let replaced = false;
    for (let candidate = 0; candidate < pool.length; candidate++) {
      if (selected.includes(candidate) || !matches[candidate]![facet]) continue;
      // Keep the highest-ranked hit and every previously represented facet.
      for (let slot = selected.length - 1; slot > 0; slot--) {
        const replacement = selected.map((hit, index) => index === slot ? candidate : hit);
        if (covered.every((present, index) => !present || replacement.some((hit) => matches[hit]![index]))) {
          selected[slot] = candidate;
          replaced = true;
          break;
        }
      }
      if (replaced) break;
    }
  }
  return selected.sort((left, right) => left - right).map((index) => pool[index]!);
}
