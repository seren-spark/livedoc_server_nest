"""Combine real generation evidence, semantic Judge and official RAGAS; export blind review."""
import argparse
from collections import Counter
import csv
import hashlib
import json
import math
from pathlib import Path
import unicodedata

from run_frameworks import digest, read_json, verified_context, write_json


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def actual_retrieval(row):
    if verified_context(row) is None:
        return None
    snapshot = row['answer']['evidence_snapshot']
    debug = snapshot.get('retrieval_debug')
    if not debug or debug.get('schema_version') != 1 or debug.get('candidate_stage') != 'authorized_fused_before_rerank':
        return None
    def sources(hits):
        return [{'doc_id': h['doc_id'], 'chunk_id': h['chunk_id'], 'document_version': h['document_version'],
                 'content': h['content'], 'source_content': h.get('source_content')} for h in hits]
    identity = {'schema_version': debug['schema_version'], 'candidate_stage': debug['candidate_stage'],
                'candidate_limit': debug['candidate_limit'], 'candidates': sources(debug['candidates']), 'ranked': sources(debug['ranked'])}
    checksum = hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return debug if checksum == snapshot.get('retrieval_debug_sha256') else None


def evidence_coverage(groups, citations):
    if not groups:
        return None
    normalize = lambda s: ''.join(unicodedata.normalize('NFKC', s).split()).casefold()
    hits = [any(all(any(c['doc_id'] == a['doc_id'] and normalize(q) in normalize(c['content']) for c in citations)
                        for q in a['quotes']) for a in g['alternatives']) for g in groups]
    return sum(hits) / len(hits)


def diagnose(row, judge):
    if row.get('status') != 'completed' or row.get('error'):
        return {'category': 'execution_error', 'passed': False}
    if row.get('grade', {}).get('permission_leak'):
        return {'category': 'permission_leak', 'passed': False}
    if row.get('grade', {}).get('citation_validity') == 0:
        return {'category': 'citation_format_error', 'passed': False}
    context = verified_context(row)
    if context is None:
        return {'category': 'invalid_evidence', 'passed': False}
    if not judge or judge.get('status') != 'checked':
        return {'category': 'judge_incomplete', 'passed': False}
    if row.get('expected_behavior') == 'abstain':
        passed = judge['behavior'] == 'abstain'
        return {'category': 'expected_abstention' if passed else 'unexpected_answer', 'passed': passed}
    debug = actual_retrieval(row)
    if debug is None:
        return {'category': 'diagnostic_unavailable', 'passed': False}
    groups = row['evidence_groups']
    coverage = {'candidate_evidence_coverage': evidence_coverage(groups, debug['candidates']),
                'ranked_evidence_coverage': evidence_coverage(groups, debug['ranked']),
                'injected_evidence_coverage': evidence_coverage(groups, context)}
    gaps = [name for name, value in coverage.items() if value != 1]
    passed = judge['correctness'] == 'correct' and judge['grounded'] and judge['behavior'] == 'answer'
    category = 'passed'
    if not passed:
        category = ('retrieval_missing_evidence' if coverage['candidate_evidence_coverage'] != 1
                    else 'ranking_missing_evidence' if coverage['ranked_evidence_coverage'] != 1
                    else 'compression_missing_evidence' if coverage['injected_evidence_coverage'] != 1 else 'generation_error')
    return {'category': category, 'passed': passed, **coverage, 'evidence_gaps': gaps,
            'note': '证据覆盖使用冻结摘录；语义支持由Judge另判，不将摘录缺失直接等同于答案错误。'}


def calibration(rows, reviews):
    by_id = {r['case_id']: r for r in rows}
    counts = Counter()
    seen = set()
    for review in reviews:
        if not review.get('human_verdict', '').strip():
            continue
        row = by_id.get(review['case_id'])
        if not row or review['case_id'] in seen or review.get('case_sha256') != row['case_sha256']:
            raise ValueError('人工复核重复、样本不存在或内容哈希已变化')
        seen.add(review['case_id'])
        if review['human_verdict'] not in ['pass', 'fail'] or not review.get('reviewer', '').strip():
            raise ValueError('人工复核必须填写pass/fail和reviewer')
        auto, human = row['diagnosis']['passed'], review['human_verdict'] == 'pass'
        counts['reviewed'] += 1
        counts['agreement'] += auto == human
        counts['false_pass'] += auto and not human
        counts['false_fail'] += not auto and human
    n = counts['reviewed']
    return {'status': 'reviewed' if n else 'pending', 'reviewed': n, 'agreement_rate': counts['agreement'] / n if n else None,
            'false_pass': counts['false_pass'], 'false_fail': counts['false_fail']}


def main():
    parser = argparse.ArgumentParser()
    for name in ['report', 'judge', 'references', 'framework', 'out']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--human-review')
    args = parser.parse_args()
    report, judge, references = read_json(args.report), read_json(args.judge), read_json(args.references)
    framework = read_json(Path(args.framework) / 'manifest.json')
    if not report.get('valid') or report['options'].get('retrieval_only'):
        raise ValueError('需要有效的端到端报告')
    if (judge['metadata'].get('report_file_sha256') != file_sha(args.report)
        or judge['metadata'].get('references_file_sha256') != file_sha(args.references)
        or references['dataset_sha256'] != report['dataset_sha256'] or references['corpus_sha256'] != report['corpus_sha256']):
        raise ValueError('Judge、参考答案或原始报告不匹配')
    if framework.get('status') not in ['completed', 'completed_with_errors', 'failed'] or framework.get('input_report_sha256') != digest(report) or framework.get('references_sha256') != digest(references):
        raise ValueError('官方框架仍在运行或来自其他输入')
    official_metrics = framework.get('ragas_metrics', {}) if framework['status'].startswith('completed') else {}
    official_scored = framework.get('ragas_complete_samples', framework['ragas_samples']) if framework['status'].startswith('completed') else 0
    judges = {r['case_id']: r for r in judge['cases']}
    framework_failures = {}
    for failure in framework.get('ragas_failed_scores', []):
        framework_failures.setdefault(failure['case_id'], []).append(failure['metric'])
    official_rows = {}
    if framework['status'].startswith('completed'):
        scores = read_json(Path(args.framework) / 'ragas_score.json')
        if len(scores) != len(framework['ragas_case_ids']):
            raise ValueError('官方逐题分数与样本ID不匹配')
        official_rows = {case_id: {key: value for key, value in score.items() if key in official_metrics
            and type(value) in (int, float) and math.isfinite(value)} for case_id, score in zip(framework['ragas_case_ids'], scores)}
    rows = []
    for row in report['cases']:
        ref = references['cases'][row['case_id']]
        if ref['query'] != row['query']:
            raise ValueError('问题与参考答案不匹配')
        result = judges.get(row['case_id'])
        identity = {'query': row['query'], 'answer': row.get('answer'), 'reference': ref}
        rows.append({'case_id': row['case_id'], 'category': row['category'], 'case_sha256': digest(identity),
                     'diagnosis': diagnose(row, result), 'judge': result,
                     'ragas_scores': official_rows.get(row['case_id'], {}),
                     'framework_failed_metrics': framework_failures.get(row['case_id'], [])})
    reviews = []
    if args.human_review:
        with open(args.human_review, encoding='utf-8-sig', newline='') as f:
            reviews = list(csv.DictReader(f))
    calibrated = calibration(rows, reviews)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    if (out / 'quality.json').exists():
        previous = read_json(out / 'quality.json')
        if previous['report_file_sha256'] != file_sha(args.report) or previous['references_file_sha256'] != file_sha(args.references):
            raise ValueError('汇总目录已属于另一份报告或参考答案，请使用新out目录')
    quality = {'report_file_sha256': file_sha(args.report), 'references_file_sha256': file_sha(args.references),
               'generation_model': report.get('environment', {}).get('llm_model'),
               'judge_model': judge['metadata']['judge_model'], 'judge_rubric_sha256': judge['metadata']['rubric_sha256'],
               'framework_judge_model': framework.get('models', {}).get('judge_model'),
               'case_count': len(rows), 'diagnoses': dict(Counter(r['diagnosis']['category'] for r in rows)),
               'judge_summary': judge['summary'], 'ragas_metrics': official_metrics,
               'framework_status': framework['status'], 'framework_error': framework.get('error'),
               'ragas_expected_answers': framework['ragas_samples'], 'ragas_scored_answers': official_scored,
               'ragas_score_counts': framework.get('ragas_score_counts', {}), 'ragas_failed_scores': framework.get('ragas_failed_scores', []),
               'calibration': calibrated, 'cases': rows}
    write_json(out / 'quality.json', quality)
    write_json(out / 'failures.json', [r for r in rows if not r['diagnosis']['passed'] or r['framework_failed_metrics']])
    # Blind review has answers, references and actual evidence, without automatic verdicts.
    chosen = {r['case_id'] for r in rows if not r['diagnosis']['passed'] or r['framework_failed_metrics'] or r['category'] == 'multi'}
    for category, count in [('fact', 4), ('exact', 4), ('no_evidence', 2), ('permission', 2)]:
        chosen.update([r['case_id'] for r in rows if r['category'] == category][:count])
    disagreement = [r for r in rows if r['judge'] and r['judge'].get('correctness') == 'correct'
                    and 'factual_correctness(mode=f1)' in r['ragas_scores']]
    chosen.update(r['case_id'] for r in sorted(disagreement, key=lambda r: r['ragas_scores']['factual_correctness(mode=f1)'])[:4])
    if not (out / 'human-review.csv').exists():
        with (out / 'human-review.csv').open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=['case_id','case_sha256','category','query','reference','required_facts','answer','actual_context','human_verdict','reviewer','notes'])
            writer.writeheader()
            for source, result in zip(report['cases'], rows):
                if source['case_id'] not in chosen:
                    continue
                ref = references['cases'][source['case_id']]
                writer.writerow({'case_id':source['case_id'],'case_sha256':result['case_sha256'],'category':source['category'],'query':source['query'],
                                 'reference':ref['reference'],'required_facts':json.dumps(ref['required_facts'],ensure_ascii=False),
                                 'answer':source.get('answer',{}).get('answer',''),'actual_context':json.dumps(verified_context(source),ensure_ascii=False),
                                 'human_verdict':'','reviewer':'','notes':''})
    lines = ['# 第二阶段：端到端质量评测', '', f"题目数：{len(rows)}；RAGAS有效评分：{official_scored}/{framework['ragas_samples']}份回答。", '',
             f"生成模型：{quality['generation_model']}；语义Judge：{quality['judge_model']}；RAGAS核验模型：{quality['framework_judge_model']}。", '',
             '| 指标 | 结果 |','| --- | ---: |']
    metrics = {key: official_metrics.get(key) for key in ['faithfulness','factual_correctness(mode=f1)']}
    for key,value in {**metrics, **{k:judge['summary'].get(k) for k in ['fact_coverage','correctness_rate','behavior_match_rate']}}.items():
        lines.append(f'| {key} | {value:.4f} |' if isinstance(value,(int,float)) else f'| {key} | 未评分 |')
    lines += ['', f"Judge已核验{judge['summary'].get('checked',0)}题，错误{judge['summary'].get('errors',0)}题；正常题Correctness分母为{judge['summary'].get('positive_checked',0)}，行为分母为{judge['summary'].get('behavior_checked',0)}。", '',
              f"官方框架状态：{framework['status']}。{framework.get('error','')}", '',
              'RAGAS每指标有效样本数：`'+json.dumps(quality['ragas_score_counts'],ensure_ascii=False)+'`；失败项单独保留，不按满分或零分补齐。', '',
              '失败归因：`'+json.dumps(quality['diagnoses'],ensure_ascii=False)+'`。', '',
              f"人工校准：{calibrated['status']}，已填写{calibrated['reviewed']}题。首批复核表覆盖{len(chosen)}题，包含所有自动失败与多资料题。", '',
              '请由人工填写human-review.csv的human_verdict（pass/fail）、reviewer和notes，然后通过--human-review重新汇总。不要把模型填写当作人工校准。', '',
              '自动事实覆盖与Correctness来自语义Judge；RAGAS指标使用官方实现。无依据／越权题单列行为检查，不计作生成指标满分。未评分、失败和跳过均保留。', '',
              '事实覆盖率与FactualCorrectness F1口径不同，不能互当整体正确率；复核表另选取Judge判correct但官方F1最低的4题用于校准分歧。', '',
              '当前合成资料与整理参考答案不能代表真实业务准确率；模型评分仍需人工校准。']
    (out / 'summary.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(json.dumps({'output':str(out),'diagnoses':quality['diagnoses'],'calibration':calibrated},ensure_ascii=False))


if __name__ == '__main__':
    main()
