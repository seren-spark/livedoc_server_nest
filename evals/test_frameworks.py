import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from run_frameworks import collect_mteb_scores, collect_ragas_details, collect_ragas_scores, digest, export_datasets, verified_context, write_json


class ExportTests(unittest.TestCase):
    def test_one_evidence_group_can_require_multiple_chunks_of_the_same_source(self):
        report, corpus, chunks, references = self.fixture()
        corpus[0]['content'] = '规划拆解目标并确认执行'
        report['corpus_sha256'] = digest([{**corpus[0], 'team_id': None, 'tags': []}])
        report['cases'][0]['evidence_groups'][0]['alternatives'][0]['quotes'] = ['拆解目标', '确认执行']
        chunks.append({'chunk_id': 'a-2', 'doc_id': 'a', 'content': '确认执行', 'passage': '确认执行'})
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            export_datasets(report, corpus, chunks, references, out)
            labels = [json.loads(line)['corpus-id'] for line in (out / 'retrieval/qrels.jsonl').read_text().splitlines()]
            self.assertEqual(set(labels), {'a-1', 'a-2'})

    def fixture(self):
        doc = {"doc_id": "a", "title": "A", "content": "规划拆解目标", "visibility": "public", "source_type": "article"}
        identity = {**doc, "team_id": None, "tags": []}
        citation = {"index": 1, "citation_id": "c1", "title": "A", "heading_path": [], "document_version": 1,
                    "content": "规划拆解目标", "doc_id": "a", "chunk_id": "a-1"}
        evidence = [{key: citation[key] for key in ["index", "citation_id", "title", "heading_path", "document_version", "content"]}]
        evidence_hash = hashlib.sha256(json.dumps(evidence, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        row = {"case_id": "q1", "query": "规划做什么", "status": "completed", "scope": {"public": True},
               "evidence_groups": [{"id": "g", "alternatives": [{"doc_id": "a", "quotes": ["拆解目标"]}]}],
               "answer": {"answer": "规划拆解目标 [1]", "trace": {"trace_id": "t"}, "evidence_snapshot": {
                   "schema_version": 1, "trace_id": "t", "citations": [citation], "evidence_sha256": evidence_hash}}}
        report = {"valid": True, "corpus_sha256": digest([identity]), "cases": [row]}
        chunks = [{"chunk_id": "a-1", "doc_id": "a", "content": doc["content"], "passage": "title: A\n规划拆解目标"}]
        references = {"cases": {"q1": {"query": row["query"], "reference": "规划负责拆解目标"}}}
        return report, [doc], chunks, references

    def test_exports_real_chunk_ids_and_only_actual_answer_context(self):
        args = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            manifest = export_datasets(*args, out)
            self.assertEqual(manifest["retrieval_queries"], 1)
            self.assertEqual(json.loads((out / "retrieval/qrels.jsonl").read_text())["corpus-id"], "a-1")
            sample = json.loads((out / "ragas.json").read_text(encoding="utf-8"))[0]
            self.assertEqual(sample["retrieved_contexts"], ["规划拆解目标"])

    def test_rejects_wrong_reference_and_frozen_source(self):
        report, corpus, chunks, references = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            references["cases"]["q1"]["query"] = "别的问题"
            with self.assertRaisesRegex(ValueError, "参考答案"):
                export_datasets(report, corpus, chunks, references, Path(directory))
            corpus[0]["content"] = "内容已变"
            with self.assertRaisesRegex(ValueError, "哈希"):
                export_datasets(report, corpus, chunks, references, Path(directory))

    def test_never_invents_chunk_labels_or_context_after_hash_mismatch(self):
        report, corpus, chunks, references = self.fixture()
        row = report["cases"][0]
        row["answer"]["evidence_snapshot"]["citations"][0]["content"] = "篡改"
        self.assertIsNone(verified_context(row))
        with tempfile.TemporaryDirectory() as directory:
            manifest = export_datasets(report, corpus, chunks, references, Path(directory))
            self.assertEqual(manifest["ragas_samples"], 0)
            chunks[0]["content"] = "不包含标注证据"
            with self.assertRaisesRegex(ValueError, "Chunk"):
                export_datasets(report, corpus, chunks, references, Path(directory))

    def test_acl_cases_are_not_misrepresented_as_unfiltered_embedding_benchmark(self):
        report, corpus, chunks, references = self.fixture()
        report["cases"][0]["scope"] = {"private": True}
        with tempfile.TemporaryDirectory() as directory:
            manifest = export_datasets(report, corpus, chunks, references, Path(directory))
            self.assertEqual(manifest["retrieval_queries"], 0)
            self.assertEqual(manifest["ragas_samples"], 1)

    def test_abstentions_are_not_given_perfect_generation_scores(self):
        report, corpus, chunks, references = self.fixture()
        for change in ['negative', 'model_not_called', 'refusal']:
            row = report['cases'][0]
            row['expected_behavior'] = 'abstain' if change == 'negative' else 'answer'
            row['answer']['evidence_snapshot']['model_called'] = change != 'model_not_called'
            row['answer']['answer'] = '未查询到相关依据，无法作答' if change == 'refusal' else '规划拆解目标'
            with tempfile.TemporaryDirectory() as directory:
                manifest = export_datasets(report, corpus, chunks, references, Path(directory))
                self.assertEqual(manifest['ragas_samples'], 0)
                self.assertTrue(any(r['stage'] == 'ragas' for r in manifest['skipped']))

    def test_core_metrics_do_not_require_unrequested_full_metric_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            write_json(out / 'ragas_score.json', [{'faithfulness': 1, 'factual_correctness(mode=f1)': .75}])
            scores = collect_ragas_scores(out, 1, ['faithfulness', 'factual_correctness(mode=f1)'])
            self.assertEqual(scores['factual_correctness(mode=f1)'], .75)

    def test_partial_metric_counts_exclude_failed_scores_and_strict_mode_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            write_json(out / 'ragas_score.json', [{'faithfulness': 1, 'factual_correctness(mode=f1)': 1},
                {'faithfulness': None, 'factual_correctness(mode=f1)': .75}])
            names = ['faithfulness', 'factual_correctness(mode=f1)']
            result = collect_ragas_details(out, 2, names)
            self.assertEqual(result['counts'], {'faithfulness': 1, 'factual_correctness(mode=f1)': 2})
            self.assertEqual(result['metrics']['factual_correctness(mode=f1)'], .875)
            self.assertEqual(result['invalid'], [(1, 'faithfulness')])
            self.assertEqual(result['complete_samples'], 1)
            with self.assertRaisesRegex(ValueError, '有效分数'):
                collect_ragas_scores(out, 2, names)

    def test_missing_and_nonfinite_mteb_results_fail_instead_of_reporting_success(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            with self.assertRaisesRegex(ValueError, "stage1"):
                collect_mteb_scores(out)
            for stage in ["stage1", "stage2"]:
                path = out / f"evalscope-mteb/run/{stage}/results/model/master/LiveDocPublicChunks.json"
                write_json(path, {"scores": {"test": [{"ndcg_at_5": 0.8, "recall_at_5": 1}]}})
            self.assertEqual(collect_mteb_scores(out)["stage2"]["metrics"]["ndcg_at_5"], 0.8)
            path.write_text('{"scores":{"test":[{"ndcg_at_5":NaN}]}}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "无效"):
                collect_mteb_scores(out)

    def test_ragas_uses_actual_f1_column_and_rejects_incomplete_or_null_scores(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            score = {"faithfulness": 1, "answer_relevancy": 0.8, "context_precision": 1,
                     "context_recall": 1, "factual_correctness(mode=f1)": 0.9}
            write_json(out / "ragas_score.json", [score])
            self.assertEqual(collect_ragas_scores(out, 1)["factual_correctness(mode=f1)"], 0.9)
            with self.assertRaisesRegex(ValueError, "数量"):
                collect_ragas_scores(out, 2)
            score["faithfulness"] = None
            write_json(out / "ragas_score.json", [score])
            with self.assertRaisesRegex(ValueError, "有效分数"):
                collect_ragas_scores(out, 1)


if __name__ == "__main__":
    unittest.main()
