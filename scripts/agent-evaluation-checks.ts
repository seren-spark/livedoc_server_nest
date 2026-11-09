import { z } from "zod";
import type { AgentCitation, AgentResult } from "../src/ai/document-agent.types.js";

const pattern = z.string().min(1).refine(value => {
  try { new RegExp(value, "u"); return true; } catch { return false; }
}, "无效评测正则");
const caseSchema = z.object({
  id: z.string().min(1), query: z.string().startsWith("查询"),
  sources: z.array(z.object({ title: z.string().min(1), content: z.string().min(1) })).min(2),
  checks: z.array(pattern).min(1), min_citations: z.number().int().min(1),
  facts: z.array(z.object({ answer_pattern: pattern, evidence_pattern: pattern,
    source_index: z.number().int().min(0) })).min(1),
  forbidden_patterns: z.array(pattern).default([]),
  compose_step: z.boolean().default(false),
}).strict();
export type AgentEvaluationCase = z.infer<typeof caseSchema>;

export function parseAgentCases(value: unknown): AgentEvaluationCase[] {
  const cases = z.array(caseSchema).min(3).parse(value);
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error("评测 ID 重复");
  for (const item of cases) {
    if (item.min_citations > item.sources.length) throw new Error(`${item.id}: 引用数量超过资料数`);
    for (const fact of item.facts) {
      const source = item.sources[fact.source_index];
      if (!source || !new RegExp(fact.evidence_pattern, "u").test(source.content))
        throw new Error(`${item.id}: 事实绑定的原文不存在`);
    }
  }
  return cases;
}

/** Deterministic corpus checks, not a semantic entailment judge. */
export function checkAgentAnswer(item: AgentEvaluationCase, result: AgentResult | undefined,
  citations: AgentCitation[], sourceIds: string[]) {
  const answer = result?.kind === "answer" ? result.answer : "";
  const ids = result?.kind === "answer" ? result.citation_ids : [];
  const adopted = citations.filter(citation => ids.includes(citation.id));
  const checks = [
    { name: "answer", passed: result?.kind === "answer" },
    { name: "citation_count", passed: new Set(ids).size >= item.min_citations },
    { name: "authorized_sources", passed: ids.every(id => adopted.some(citation =>
      citation.id === id && sourceIds.includes(citation.doc_id ?? ""))) },
    ...item.checks.map(pattern => ({ name: `required:${pattern}`, passed: new RegExp(pattern, "u").test(answer) })),
    ...item.forbidden_patterns.map(pattern => ({ name: `forbidden:${pattern}`, passed: !new RegExp(pattern, "u").test(answer) })),
    ...item.facts.map(fact => ({ name: `evidence:${fact.answer_pattern}`, passed:
      answer.split(/\r?\n/u).some(line => new RegExp(fact.answer_pattern, "u").test(line) && adopted.some(citation =>
        citation.doc_id === sourceIds[fact.source_index] && line.includes(`[${citation.id}]`) &&
        new RegExp(fact.evidence_pattern, "u").test(citation.source_content ?? citation.snippet ?? ""))) })),
  ];
  return { passed: checks.every(check => check.passed), checks };
}
