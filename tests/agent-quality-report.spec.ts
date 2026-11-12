import { agentCaseFingerprint, compareAgentQuality, createAgentBlindReview, summarizeAgentQuality, validateAgentGrade,
  type QualityReport } from '../scripts/agent-quality.js';

const grade = (passed: boolean) => ({ passed, criteria: {
  correctness: passed, completeness: true, evidence_support: true, constraints: true,
}, issues: passed ? [] : ['遗漏事实'] });
function report(): QualityReport {
  return { mode: 'real', dataset_hash: 'dataset', rubric_version: 'v3', code_commit: 'commit', implementation_hash: 'source',
    metadata: { models: { main: 'main', critic: 'judge' } }, rows: [
      { case_id: 'a', group: 'editing', status: 'pass', rule_status: 'pass', model_grade: grade(true),
        evaluation_input: { query: '改写', actual: { kind: 'edits', edits: [] }, evidence: [] } },
      { case_id: 'b', group: 'editing', status: 'fail', rule_status: 'pass', model_grade: grade(false),
        evaluation_input: { query: '改写', actual: { kind: 'edits', edits: [] }, evidence: [] } },
      { case_id: 'c', group: 'memory', status: 'blocked', rule_status: 'pass', semantic_status: 'error',
        evaluation_input: { query: '解释', actual: { kind: 'answer', answer: 'x' }, evidence: [] } },
      { case_id: 'd', group: 'recovery', status: 'not_run', checks: [] },
    ] };
}

describe('agent business quality calibration', () => {
  test('binds human review to the grading rubric and dataset even when the output is unchanged', () => {
    const source = report(), review = createAgentBlindReview(source);
    expect(() => summarizeAgentQuality({ ...source, rubric_version: 'different' }, review)).toThrow('rubric version');
    expect(() => summarizeAgentQuality({ ...source, dataset_hash: 'different' }, review)).toThrow('rubric version');
  });
  test('groups delivered outputs by the actual successful model after fallback', () => {
    const source = report();
    source.rows[0]!.attempts = [{ traces: [
      { kind: 'model', status: 'error', name: 'main', task_id: 'primary', attributes: { model: 'main' } },
      { kind: 'model', status: 'success', name: 'main', task_id: 'primary', attributes: { model: 'backup' } },
      { kind: 'model', status: 'success', name: 'critic', task_id: 'primary', attributes: { model: 'judge' } },
    ] }];
    const summary = summarizeAgentQuality(source);
    expect(summary.by_model.backup).toMatchObject({ total: 1, semantic_passed: 1 });
    expect(summary.rows[0]).toMatchObject({ model: 'backup', configured_main_model: 'main' });
  });
  test('separates mechanical success, semantic failure and ungraded output', () => {
    const summary = summarizeAgentQuality(report());
    expect(summary.summary).toMatchObject({ total: 4, with_output: 3, rule_passed: 3,
      semantic_checked: 2, semantic_passed: 1, semantic_errors: 1, semantic_pass_rate: 0.5,
      semantic_coverage: 2 / 3, quality_success_rate: 0.25 });
    expect(summary.calibration).toMatchObject({ status: 'pending', agreement_rate: null });
    expect(summary.by_group.editing).toMatchObject({ total: 2, semantic_checked: 2 });
    expect(summary.by_model.main).toMatchObject({ total: 4 });
    expect(summary.by_code_version['commit:source']).toMatchObject({ total: 4 });
  });

  test('binds blind review to the exact input, output and evidence without exposing automatic grades', () => {
    const source = report();
    const review = createAgentBlindReview(source);
    expect(review).toHaveLength(3);
    expect(review[0]).toMatchObject({ case_id: 'a', query: '改写', human_verdict: '', reviewer: '' });
    expect(review[0]).not.toHaveProperty('model_grade');
    expect(review[0]).not.toHaveProperty('overall_status');
    const changedReview = JSON.parse(JSON.stringify(review));
    changedReview[0].actual = { kind: 'answer', answer: 'edited in review file' };
    expect(() => summarizeAgentQuality(source, changedReview)).toThrow('source content has changed');
    const original = review[0]!.case_sha256;
    source.rows[0]!.evaluation_input.actual = { kind: 'answer', answer: 'different' };
    expect(agentCaseFingerprint(source.rows[0]!)).not.toBe(original);
    expect(() => summarizeAgentQuality(source, review)).toThrow('stale');
  });

  test('computes human disagreement only where semantic grading is valid', () => {
    const source = report();
    const review = createAgentBlindReview(source);
    review[0]!.human_verdict = 'fail'; review[0]!.reviewer = 'reviewer-a';
    review[1]!.human_verdict = 'pass'; review[1]!.reviewer = 'reviewer-a';
    review[2]!.human_verdict = 'pass'; review[2]!.reviewer = 'reviewer-b';
    expect(summarizeAgentQuality(source, review).calibration).toMatchObject({ status: 'reviewed', reviewed: 3,
      comparable: 2, false_pass: 1, false_fail: 1, ungraded_reviewed: 1, agreement_rate: 0 });
    expect(() => summarizeAgentQuality(source, [...review, review[0]!])).toThrow('duplicated');
    review[0]!.reviewer = '';
    expect(() => summarizeAgentQuality(source, review)).toThrow('actual reviewer');
  });

  test('rejects contradictory or incomplete judge responses', () => {
    expect(validateAgentGrade(grade(true)).passed).toBe(true);
    expect(() => validateAgentGrade({ ...grade(false), passed: true })).toThrow('contradicts');
    expect(() => validateAgentGrade({ ...grade(false), issues: [] })).toThrow('issues');
    expect(() => validateAgentGrade({ ...grade(true), criteria: { correctness: true } })).toThrow('criterion');
    const source = report();
    source.rows[0]!.model_grade = { passed: true };
    expect(summarizeAgentQuality(source).summary.semantic_errors).toBe(2);
  });

  test('controlled pass does not become a model quality claim and supports legacy reports', () => {
    const source = report(); source.mode = 'controlled';
    source.rows = [{ case_id: 'legacy', group: 'knowledge', status: 'pass', attempts: [{
      input: { query: '问题' }, delivery: { result: { kind: 'answer', answer: 'x' }, citations: [] },
    }] }];
    const summary = summarizeAgentQuality(source);
    expect(summary.summary).toMatchObject({ rule_passed: 1, semantic_checked: 0, semantic_pass_rate: null, quality_success_rate: null });
    expect(createAgentBlindReview(source)[0]).toMatchObject({ query: '问题', actual: { answer: 'x' } });
  });

  test('comparison checks protocol and exposes unmatched cases', () => {
    const source = report(), baseline = report();
    baseline.rows.pop();
    expect(compareAgentQuality(source, baseline)).toMatchObject({ same_case_set: false, added: ['d'], removed: [] });
    baseline.rubric_version = 'old';
    expect(() => compareAgentQuality(source, baseline)).toThrow('rubric_version');
    baseline.rubric_version = source.rubric_version; baseline.dataset_hash = 'other';
    expect(() => compareAgentQuality(source, baseline)).toThrow('dataset_hash');
  });
});
