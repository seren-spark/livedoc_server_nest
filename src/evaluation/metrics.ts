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

export function gradeGroundedAnswer(answer: string, citationCount: number): {
  grounded: boolean;
  has_citation: boolean;
} {
  const cited = /\[\d+\]/u.test(answer);
  const refused = /未查询到相关依据|无法作答/u.test(answer);
  return { grounded: refused || (citationCount > 0 && cited), has_citation: cited };
}

export function adoptionRate(completedEvidenceAnswers: number, insertedAnswers: number): number {
  return round(completedEvidenceAnswers ? insertedAnswers / completedEvidenceAnswers : 0);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
