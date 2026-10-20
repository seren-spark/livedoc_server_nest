import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from summarize_quality import actual_retrieval, calibration, diagnose, file_sha, main
from run_frameworks import digest, write_json
import test_frameworks


class QualityTests(unittest.TestCase):
    def fixture(self):
        row = test_frameworks.ExportTests().fixture()[0]['cases'][0]
        row['expected_behavior'] = 'answer'
        snapshot = row['answer']['evidence_snapshot']
        hit = {k: snapshot['citations'][0][k] for k in ['doc_id', 'chunk_id', 'document_version', 'content']}
        hit['source_content'] = None
        debug = {'schema_version': 1, 'candidate_stage': 'authorized_fused_before_rerank',
                 'candidate_limit': 20, 'candidates': [hit], 'ranked': [hit]}
        snapshot['retrieval_debug'] = copy.deepcopy(debug)
        snapshot['retrieval_debug_sha256'] = hashlib.sha256(json.dumps(debug, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        judge = {'status': 'checked', 'correctness': 'correct', 'grounded': True, 'behavior': 'answer'}
        return row, judge

    def test_attribution_uses_verified_actual_retrieval_not_independent_search(self):
        row, judge = self.fixture()
        self.assertEqual(diagnose(row, judge)['category'], 'passed')
        # A semantic success remains a success even without the exact annotated excerpt.
        row['evidence_groups'][0]['alternatives'][0]['quotes'] = ['换一种语义表达']
        self.assertEqual(diagnose(row, judge)['category'], 'passed')
        judge['correctness'] = 'partial'
        self.assertEqual(diagnose(row, judge)['category'], 'retrieval_missing_evidence')
        row['retrieval'] = {'citations': [{'content': '换一种语义表达'}]}
        del row['answer']['evidence_snapshot']['retrieval_debug']
        self.assertEqual(diagnose(row, judge)['category'], 'diagnostic_unavailable')

    def test_tampered_evidence_is_not_trusted_but_score_serialization_is_irrelevant(self):
        row, judge = self.fixture()
        row['answer']['evidence_snapshot']['retrieval_debug']['candidates'][0]['score'] = 1e-20
        self.assertIsNotNone(actual_retrieval(row))
        row['answer']['evidence_snapshot']['retrieval_debug']['candidates'][0]['content'] = '篡改'
        self.assertIsNone(actual_retrieval(row))
        self.assertEqual(diagnose(row, judge)['category'], 'diagnostic_unavailable')

    def test_refusals_and_errors_are_separate_from_generation_scores(self):
        row, judge = self.fixture()
        row['expected_behavior'] = 'abstain'
        self.assertEqual(diagnose(row, judge)['category'], 'unexpected_answer')
        judge['behavior'] = 'abstain'
        self.assertTrue(diagnose(row, judge)['passed'])
        row['grade'] = {'citation_validity': 0}
        self.assertEqual(diagnose(row, judge)['category'], 'citation_format_error')
        row['grade'] = {'permission_leak': True}
        self.assertEqual(diagnose(row, judge)['category'], 'permission_leak')
        row['status'] = 'error'
        self.assertEqual(diagnose(row, judge)['category'], 'execution_error')

    def test_human_calibration_is_pending_until_a_reviewer_labels_matching_samples(self):
        rows = [{'case_id': 'a', 'case_sha256': 'frozen', 'diagnosis': {'passed': True}}]
        self.assertEqual(calibration(rows, [])['status'], 'pending')
        review = {'case_id': 'a', 'case_sha256': 'frozen', 'human_verdict': 'fail', 'reviewer': 'reviewer'}
        self.assertEqual(calibration(rows, [review])['false_pass'], 1)
        with self.assertRaises(ValueError):
            calibration(rows, [{**review, 'case_sha256': 'stale'}])
        with self.assertRaises(ValueError):
            calibration(rows, [review, review])
        with self.assertRaises(ValueError):
            calibration(rows, [{**review, 'reviewer': ''}])

    def test_cli_exports_blind_review_then_imports_real_labels_without_overwriting_them(self):
        row, judge = self.fixture()
        row['category'] = 'fact'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = {'valid': True, 'options': {}, 'dataset_sha256': 'dataset', 'corpus_sha256': 'corpus', 'cases': [row]}
            references = {'dataset_sha256': 'dataset', 'corpus_sha256': 'corpus', 'cases': {'q1': {
                'query': row['query'], 'reference': '规划拆解目标', 'required_facts': [{'id': 'f', 'text': '拆解目标'}]}}}
            write_json(root / 'report.json', report)
            write_json(root / 'references.json', references)
            write_json(root / 'judge.json', {'metadata': {'report_file_sha256': file_sha(root / 'report.json'),
                'references_file_sha256': file_sha(root / 'references.json'), 'judge_model': 'test', 'rubric_sha256': 'test'},
                'summary': {}, 'cases': [{'case_id': 'q1', **judge}]})
            write_json(root / 'framework/manifest.json', {'status': 'completed', 'input_report_sha256': digest(report),
                'references_sha256': digest(references), 'ragas_metrics': {'faithfulness': 1}, 'ragas_samples': 1, 'ragas_case_ids': ['q1']})
            write_json(root / 'framework/ragas_score.json', [{'faithfulness': 1}])
            args = ['summary']
            for name, value in [('report', 'report.json'), ('judge', 'judge.json'), ('references', 'references.json'),
                                ('framework', 'framework'), ('out', 'out')]:
                args += ['--' + name, str(root / value)]
            with patch('sys.argv', args):
                main()
            quality = json.loads((root / 'out/quality.json').read_text(encoding='utf-8'))
            self.assertEqual(quality['calibration']['status'], 'pending')
            import csv
            review_path = root / 'out/human-review.csv'
            with review_path.open(encoding='utf-8-sig', newline='') as f:
                reviews = list(csv.DictReader(f))
            self.assertNotIn('auto_verdict', reviews[0])
            self.assertEqual(reviews[0]['human_verdict'], '')
            # Test-only human label; never written into the real experiment.
            reviews[0].update(human_verdict='pass', reviewer='fixture-reviewer')
            with review_path.open('w', encoding='utf-8-sig', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=list(reviews[0])); writer.writeheader(); writer.writerows(reviews)
            original = review_path.read_bytes()
            with patch('sys.argv', args + ['--human-review', str(review_path)]):
                main()
            quality = json.loads((root / 'out/quality.json').read_text(encoding='utf-8'))
            self.assertEqual(quality['calibration']['agreement_rate'], 1)
            self.assertEqual(review_path.read_bytes(), original)
            # An interrupted official run must not turn expected samples or partial metrics into successes.
            manifest = json.loads((root / 'framework/manifest.json').read_text(encoding='utf-8'))
            manifest.update(status='failed', error='quota unavailable')
            write_json(root / 'framework/manifest.json', manifest)
            with patch('sys.argv', args):
                main()
            quality = json.loads((root / 'out/quality.json').read_text(encoding='utf-8'))
            self.assertEqual(quality['framework_status'], 'failed')
            self.assertEqual(quality['ragas_metrics'], {})
            self.assertEqual(quality['ragas_scored_answers'], 0)
            self.assertEqual(review_path.read_bytes(), original)
            manifest.update(status='completed_with_errors', ragas_complete_samples=0,
                ragas_failed_scores=[{'case_id': 'q1', 'metric': 'faithfulness'}])
            write_json(root / 'framework/manifest.json', manifest)
            with patch('sys.argv', args):
                main()
            failures = json.loads((root / 'out/failures.json').read_text(encoding='utf-8'))
            self.assertEqual(failures[0]['framework_failed_metrics'], ['faithfulness'])


if __name__ == '__main__':
    unittest.main()
