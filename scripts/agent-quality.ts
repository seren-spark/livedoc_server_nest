import assert from 'node:assert/strict';
import { fingerprint } from '../src/evaluation/rag-evaluation.js';

export const QUALITY_CRITERIA = ['correctness', 'completeness', 'evidence_support', 'constraints'] as const;
type Criterion = typeof QUALITY_CRITERIA[number];
export interface AgentGrade {
  passed: boolean;
  criteria: Record<Criterion, boolean>;
  issues: string[];
}
export interface QualityReport {
  mode: string;
  suite?: string;
  dataset_hash: string;
  rubric_version: string;
  code_commit?: string;
  implementation_hash?: string;
  metadata?: { models?: Record<string, string> };
  rows: Array<Record<string, any>>;
}
export interface HumanReview {
  [key: string]: unknown;
  case_id: string;
  case_sha256: string;
  dataset_hash: string;
  rubric_version: string;
  human_verdict: '' | 'pass' | 'fail';
  reviewer: string;
  notes: string;
}

export function validateAgentGrade(value: unknown): AgentGrade {
  const grade = value as AgentGrade | undefined;
  assert(grade && typeof grade.passed === 'boolean' && grade.criteria && Array.isArray(grade.issues), 'Invalid model grade');
  assert(QUALITY_CRITERIA.every((key) => typeof grade.criteria[key] === 'boolean'), 'Missing model grade criterion');
  assert(grade.issues.every((issue) => typeof issue === 'string' && issue.trim()), 'Invalid model grade issue');
  assert.equal(grade.passed, QUALITY_CRITERIA.every((key) => grade.criteria[key]), 'Model grade contradicts its criteria');
  assert(grade.passed ? grade.issues.length === 0 : grade.issues.length > 0, 'Model grade contradicts its issues');
  return grade;
}

function reviewInput(row: Record<string, any>) {
  const attempt = row.attempts?.findLast((value: any) => value.delivery?.result);
  return row.evaluation_input ?? (attempt ? {
    query: attempt.input?.query,
    editor_snapshot: attempt.input?.editor_snapshot,
    actual: attempt.delivery.result,
    evidence: attempt.delivery.citations,
    constraints: attempt.constraints,
    plan_confirmation: row.plan_before_confirmation ? { confirmed: true, plan: row.plan_before_confirmation.plan } : undefined,
  } : null);
}

export function agentCaseFingerprint(row: Record<string, any>): string {
  return fingerprint(JSON.parse(JSON.stringify({ case_id: row.case_id, input: reviewInput(row) })));
}

export function createAgentBlindReview(report: QualityReport) {
  validateReport(report);
  return report.rows.filter((row) => reviewInput(row)).map((row) => ({
    case_id: row.case_id,
    case_sha256: agentCaseFingerprint(row),
    dataset_hash: report.dataset_hash,
    rubric_version: report.rubric_version,
    ...reviewInput(row),
    human_verdict: '' as HumanReview['human_verdict'], reviewer: '', notes: '',
  }));
}

function validateReport(report: QualityReport) {
  assert(report && Array.isArray(report.rows) && typeof report.dataset_hash === 'string' && typeof report.rubric_version === 'string', 'Invalid business report');
  assert(report.rows.every((row) => typeof row.case_id === 'string' && row.case_id), 'Missing case identity');
  assert.equal(new Set(report.rows.map((row) => row.case_id)).size, report.rows.length, 'Duplicate business case identity');
}

function semanticStatus(row: Record<string, any>, mode: string) {
  if (row.semantic_status === 'error') return 'error';
  if (row.model_grade) {
    try { return validateAgentGrade(row.model_grade).passed ? 'pass' : 'fail'; }
    catch { return 'error'; }
  }
  return mode === 'controlled' ? 'not_required' : 'not_run';
}

function ruleStatus(row: Record<string, any>) {
  if (row.rule_status) return row.rule_status as string;
  // Legacy evaluators invoked the semantic judge only after all mechanical checks passed.
  if (row.model_grade || row.judge_usage || row.error_phase === 'judge' || row.status === 'pass') return 'pass';
  return row.status === 'not_run' ? 'not_run' : row.status === 'blocked' ? 'blocked' : 'fail';
}

function deliveredModel(row: Record<string, any>, report: QualityReport): string {
  const generated = (row.attempts ?? []).flatMap((attempt: any) => attempt.traces ?? [])
    .filter((span: any) => span.kind === 'model' && span.status === 'success' && span.name === 'main' &&
      (span.task_id === 'primary' || span.agent_role === 'primary')).at(-1);
  return String(generated?.attributes?.model ?? report.metadata?.models?.main ?? 'unavailable');
}

export function summarizeAgentQuality(report: QualityReport, reviews: HumanReview[] = []) {
  validateReport(report);
  const rows = report.rows.map((row) => ({
    case_id: row.case_id, group: row.group ?? 'unavailable',
    case_sha256: agentCaseFingerprint(row), has_output: Boolean(reviewInput(row)),
    rule_status: ruleStatus(row), semantic_status: semanticStatus(row, report.mode),
    overall_status: row.status,
    model: deliveredModel(row, report),
    configured_main_model: report.metadata?.models?.main ?? 'unavailable',
    code_version: `${report.code_commit ?? 'unavailable'}:${report.implementation_hash ?? 'unavailable'}`,
  }));
  const byId = new Map(rows.map((row) => [row.case_id, row]));
  const seen = new Set<string>();
  const calibration = { status: 'pending', reviewed: 0, comparable: 0, agreement: 0, false_pass: 0, false_fail: 0,
    rule_human_disagreements: 0, ungraded_reviewed: 0, agreement_rate: null as number | null };
  for (const review of reviews) {
    const row = byId.get(review.case_id);
    assert(row && row.has_output && !seen.has(review.case_id) && row.case_sha256 === review.case_sha256,
      'Human review is duplicated, unknown, unavailable or stale');
    seen.add(review.case_id);
    assert(review.dataset_hash === report.dataset_hash && review.rubric_version === report.rubric_version,
      'Human review dataset or grading rubric version differs');
    const { case_id, case_sha256, dataset_hash, rubric_version, human_verdict, reviewer, notes, ...input } = review;
    if (Object.keys(input).length)
      assert.equal(fingerprint(JSON.parse(JSON.stringify({ case_id, input }))), case_sha256, 'Human review source content has changed');
    if (!review.human_verdict) continue;
    assert(['pass', 'fail'].includes(review.human_verdict) && typeof review.reviewer === 'string' && review.reviewer.trim(),
      'Human review requires pass/fail and an actual reviewer');
    assert(typeof review.notes === 'string', 'Invalid human review notes');
    calibration.reviewed++;
    const passed = review.human_verdict === 'pass';
    if (row.rule_status !== 'pass' && passed) calibration.rule_human_disagreements++;
    if (!['pass', 'fail'].includes(row.semantic_status)) { calibration.ungraded_reviewed++; continue; }
    calibration.comparable++;
    const auto = row.semantic_status === 'pass';
    if (auto === passed) calibration.agreement++;
    if (auto && !passed) calibration.false_pass++;
    if (!auto && passed) calibration.false_fail++;
  }
  calibration.status = calibration.reviewed ? 'reviewed' : 'pending';
  calibration.agreement_rate = calibration.comparable ? calibration.agreement / calibration.comparable : null;
  const counts = (subset: typeof rows) => {
    const graded = subset.filter((row) => ['pass', 'fail'].includes(row.semantic_status));
    const outputs = subset.filter((row) => row.has_output);
    return { total: subset.length, with_output: outputs.length,
      rule_passed: subset.filter((row) => row.rule_status === 'pass').length,
      semantic_checked: graded.length, semantic_passed: graded.filter((row) => row.semantic_status === 'pass').length,
      semantic_errors: subset.filter((row) => row.semantic_status === 'error').length,
      semantic_coverage: outputs.length && report.mode === 'real' ? graded.length / outputs.length : null,
      semantic_pass_rate: graded.length ? graded.filter((row) => row.semantic_status === 'pass').length / graded.length : null,
      quality_success_rate: report.mode === 'real' && subset.length
        ? subset.filter((row) => row.rule_status === 'pass' && row.semantic_status === 'pass').length / subset.length : null };
  };
  const grouped = (field: 'group' | 'model' | 'code_version') => Object.fromEntries(
    [...new Set(rows.map((row) => row[field]))].map((key) => [key, counts(rows.filter((row) => row[field] === key))]));
  return { schema_version: 'agent-quality-v2', dataset_hash: report.dataset_hash, rubric_version: report.rubric_version,
    mode: report.mode, suite: report.suite ?? 'business', model_configuration: report.metadata?.models ?? {},
    summary: counts(rows), calibration, by_group: grouped('group'), by_model: grouped('model'), by_code_version: grouped('code_version'),
    disagreements: rows.filter((row) => row.rule_status === 'pass' && ['fail', 'error'].includes(row.semantic_status)), rows };
}

export function compareAgentQuality(report: QualityReport, baseline: QualityReport) {
  for (const field of ['dataset_hash', 'rubric_version', 'mode'] as const)
    assert.equal(report[field], baseline[field], `Baseline differs in ${field}`);
  assert.equal(report.suite ?? 'business', baseline.suite ?? 'business', 'Baseline uses a different suite');
  const before = summarizeAgentQuality(baseline), after = summarizeAgentQuality(report);
  const beforeIds = new Set(before.rows.map((row) => row.case_id));
  const afterIds = new Set(after.rows.map((row) => row.case_id));
  return { same_case_set: beforeIds.size === afterIds.size && [...beforeIds].every((id) => afterIds.has(id)),
    added: [...afterIds].filter((id) => !beforeIds.has(id)), removed: [...beforeIds].filter((id) => !afterIds.has(id)),
    baseline: before.summary, candidate: after.summary,
    cases: after.rows.filter((row) => beforeIds.has(row.case_id)).map((row) => ({ case_id: row.case_id,
      before: before.rows.find((old) => old.case_id === row.case_id), after: row })) };
}
