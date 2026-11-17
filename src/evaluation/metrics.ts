/**
 * @file RAG 评测指标。计算检索命中、回答依据和用户采纳率等基础指标。
 */
export interface RetrievalCaseResult {
  expected_chunk_ids: string[];
  retrieved_chunk_ids: string[];
  permitted_chunk_ids?: string[];
}

export interface RetrievalMetrics {
  recall_at_k: number;
  mean_reciprocal_rank: number;
  precision_at_k: number;
  permission_leak_rate: number;
}

/**
 * 比较检索命中与标注来源，计算检索质量指标。
 *
 * @param results 已经完成的步骤或评测结果。
 * @returns RetrievalMetrics 类型的处理结果。
 */
export function calculateRetrievalMetrics(results: RetrievalCaseResult[]): RetrievalMetrics {
  if (!results.length) {
    return { recall_at_k: 0, mean_reciprocal_rank: 0, precision_at_k: 0, permission_leak_rate: 0 };
  }
  let recall = 0;
  let reciprocalRank = 0;
  let precision = 0;
  let retrieved = 0;
  let leaked = 0;
  for (const result of results) {
    const expected = new Set(result.expected_chunk_ids);
    const permitted = result.permitted_chunk_ids ? new Set(result.permitted_chunk_ids) : null;
    const relevant = result.retrieved_chunk_ids.filter((id) => expected.has(id));
    recall += expected.size ? new Set(relevant).size / expected.size : 1;
    precision += result.retrieved_chunk_ids.length ? relevant.length / result.retrieved_chunk_ids.length : 0;
    const rank = result.retrieved_chunk_ids.findIndex((id) => expected.has(id));
    reciprocalRank += rank >= 0 ? 1 / (rank + 1) : 0;
    retrieved += result.retrieved_chunk_ids.length;
    if (permitted) leaked += result.retrieved_chunk_ids.filter((id) => !permitted.has(id)).length;
  }
  return {
    recall_at_k: round(recall / results.length),
    mean_reciprocal_rank: round(reciprocalRank / results.length),
    precision_at_k: round(precision / results.length),
    permission_leak_rate: round(retrieved ? leaked / retrieved : 0),
  };
}

/**
 * 检查回答是否引用有效证据，并计算有据回答的得分。
 *
 * @param answer 本轮生成的回答文本。
 * @param citationCount 本次使用的引用证据数量。
 * @returns 整理后的状态与操作结果对象。
 */
export function gradeGroundedAnswer(answer: string, citationCount: number): {
  grounded: boolean;
  has_citation: boolean;
} {
  const cited = /\[\d+\]/u.test(answer);
  const refused = /未查询到相关依据|无法作答/u.test(answer);
  return { grounded: refused || (citationCount > 0 && cited), has_citation: cited };
}

/**
 * 根据反馈次数计算用户采纳率。
 *
 * @param completedEvidenceAnswers completedEvidenceAnswers 参数（number）。
 * @param insertedAnswers insertedAnswers 参数（number）。
 * @returns 计算得到的数值。
 */
export function adoptionRate(completedEvidenceAnswers: number, insertedAnswers: number): number {
  return round(completedEvidenceAnswers ? insertedAnswers / completedEvidenceAnswers : 0);
}

/**
 * 按指定位数四舍五入，统一指标展示精度。
 *
 * @param value 待校验或转换的值。
 * @returns 计算得到的数值。
 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
