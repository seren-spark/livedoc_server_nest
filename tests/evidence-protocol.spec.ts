import { afterEach, describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const folders: string[] = [];
const runScript = (script: string, args: string[]) => execFileSync(process.execPath,
  ['--loader', 'ts-node/esm/transpile-only', script, ...args],
  { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
function report(selection: boolean): any {
  return { version: 4, valid: true, dataset_sha256: 'dataset', corpus_sha256: 'corpus',
    chunk_manifest_sha256: 'chunks', dataset_version: 'retrieval-v2-longform', source_sha256: 'same-code',
    corpus_before: [{ doc_id: 'doc', version: 1 }], environment: { rerank_model: 'fixed' }, metrics: { error_count: 0 },
    options: { mode: 'hybrid', rerank: true, top_k: 3, candidate_k: 20, expand_query: false,
      retrieval_only: true, case_ids: ['q'], evidence_selection: selection,
      selection_strategy: selection ? 'facet-v1' : 'rank-v1' },
    cases: [{ case_id: 'q', relevant_doc_ids: ['doc'], search: {}, retrieval_grade: {
      recall_at_3: 1, mrr_at_3: 1, ndcg_at_3: 1, candidate_recall_at_20: 1, evidence_at_3: { recall: 1 },
    } }] };
}
function compare(baseline: any, candidate: any) {
  const folder = resolve('.cache', 'evidence-protocol', randomUUID());
  mkdirSync(folder, { recursive: true });
  folders.push(folder);
  const first = resolve(folder, 'baseline.json'), second = resolve(folder, 'candidate.json'), output = resolve(folder, 'comparison.json');
  writeFileSync(first, JSON.stringify(baseline));
  writeFileSync(second, JSON.stringify(candidate));
  runScript('scripts/compare-rag-evaluations.ts', ['--baseline', first, '--candidate', second, '--output', output]);
  return JSON.parse(readFileSync(output, 'utf8'));
}
afterEach(() => {
  for (const folder of folders.splice(0)) {
    for (const file of ['baseline.json', 'candidate.json', 'comparison.json', 'comparison.md']) {
      const path = resolve(folder, file);
      if (existsSync(path)) unlinkSync(path);
    }
    rmdirSync(folder);
  }
});

describe('versioned evidence-selection experiment protocol', () => {
  test('frozen retrieval defaults off, explicit experiment opts in, and end-to-end retains production selection', () => {
    const args = ['--retrieval-only', '--chunk-manifest', 'evals/rag_chunks.json', '--validate-only'];
    const baseline = JSON.parse(runScript('scripts/evaluate-rag.ts', args));
    const treatment = JSON.parse(runScript('scripts/evaluate-rag.ts', [...args, '--evidence-selection']));
    expect(baseline).toMatchObject({ evidence_selection: false, selection_strategy: 'rank-v1', answer_selection_strategy: null });
    expect(treatment).toMatchObject({ evidence_selection: true, selection_strategy: 'facet-v1' });
    const endToEnd = JSON.parse(runScript('scripts/evaluate-rag.ts',
      ['--end-to-end', '--chunk-manifest', 'evals/rag_chunks.json', '--validate-only']));
    expect(endToEnd).toMatchObject({ evidence_selection: true, selection_strategy: 'facet-v1', answer_selection_strategy: 'facet-v1' });
  });

  test('identifies a single selection treatment without changing frozen dataset identity', () => {
    const result = compare(report(false), report(true));
    expect(result.dataset_version).toBe('retrieval-v2-longform');
    expect(result.comparison_factors).toMatchObject({ baseline_selection_strategy: 'rank-v1',
      candidate_selection_strategy: 'facet-v1', changed_factors: ['evidence_selection'],
      unrecorded_factors: [], isolated_factor: 'evidence_selection', attribution: 'single_recorded_factor' });
  });

  test('distinguishes legacy unrecorded selection and marks confounded changes', () => {
    const legacy = report(false);
    legacy.version = 3;
    delete legacy.options.evidence_selection;
    delete legacy.options.selection_strategy;
    const migrated = compare(legacy, report(true));
    expect(migrated.comparison_factors).toMatchObject({ baseline_selection_strategy: 'legacy-unspecified',
      candidate_selection_strategy: 'facet-v1', unrecorded_factors: ['baseline.evidence_selection'],
      isolated_factor: null, attribution: 'mixed_or_unrecorded_factors' });
    const treatment = report(true);
    treatment.options.rerank = false;
    expect(compare(report(false), treatment).comparison_factors).toMatchObject({
      changed_factors: ['rerank', 'evidence_selection'], isolated_factor: null, attribution: 'mixed_or_unrecorded_factors',
    });
  });
});
