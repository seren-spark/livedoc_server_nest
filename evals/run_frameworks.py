"""Official EvalScope RAGEval -> MTEB / RAGAS; NestJS stays the production runtime."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def write_jsonl(path, rows):
    Path(path).write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def collect_mteb_scores(out):
    results = {}
    for stage in ["stage1", "stage2"]:
        paths = list((out / "evalscope-mteb").glob(f"*/{stage}/results/**/LiveDocPublicChunks.json"))
        if len(paths) != 1:
            raise ValueError(f"缺少或存在多份 MTEB {stage} 结果")
        scores = read_json(paths[0])["scores"]["test"]
        if len(scores) != 1:
            raise ValueError("MTEB 自定义任务结果应只有一个子集")
        # Tiny datasets can have undefined nAUC; retain raw artifacts and summarize ranking metrics only.
        metrics = {key: value for key, value in scores[0].items()
                   if key.startswith(("ndcg_at_", "recall_at_", "mrr_at_"))}
        if not metrics or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in metrics.values()):
            raise ValueError(f"MTEB {stage} 返回无效排名分数")
        results[stage] = {"artifact": str(paths[0].relative_to(out)), "metrics": metrics}
    return results


def collect_ragas_details(out, expected_count, metric_names=None):
    scores = read_json(out / "ragas_score.json")
    metric_names = metric_names or ["faithfulness", "answer_relevancy", "context_precision", "context_recall", "factual_correctness(mode=f1)"]
    if len(scores) != expected_count or not scores:
        raise ValueError("RAGAS 评分数量与导出样本数量不符")
    invalid = [(i, key) for i, row in enumerate(scores) for key in metric_names
               if type(row.get(key)) not in (int, float) or not math.isfinite(row[key]) or not 0 <= row[key] <= 1]
    valid = {key: [row[key] for row in scores if type(row.get(key)) in (int, float) and math.isfinite(row[key]) and 0 <= row[key] <= 1] for key in metric_names}
    return {"metrics": {key: sum(values) / len(values) for key, values in valid.items() if values},
            "counts": {key: len(values) for key, values in valid.items()}, "invalid": invalid,
            "complete_samples": expected_count - len({i for i, _ in invalid})}


def collect_ragas_scores(out, expected_count, metric_names=None):
    result = collect_ragas_details(out, expected_count, metric_names)
    if result['invalid']:
        raise ValueError(f"RAGAS 缺少有效分数：{result['invalid']}")
    return result['metrics']


def write_summary(out, manifest):
    lines = ["# LiveDoc 官方框架评测", "", f"运行状态：{manifest['status']}", "",
             f"MTEB：{manifest.get('retrieval_queries', 0)} 个问题，{manifest.get('chunk_count', 0)} 个公共 Chunk。",
             f"RAGAS：{manifest.get('ragas_samples', 0)} 个回答样本。", "",
             "| 阶段／指标 | 分数 |", "| --- | ---: |"]
    for stage, result in manifest.get("mteb", {}).items():
        for key in ["ndcg_at_3", "recall_at_3", "mrr_at_3"]:
            if key in result["metrics"]:
                lines.append(f"| MTEB {stage} / {key} | {result['metrics'][key]:.4f} |")
    for key, value in manifest.get("ragas_metrics", {}).items():
        lines.append(f"| RAGAS / {key} | {value:.4f} |")
    lines.extend(["", f"实际模型调用次数：`{json.dumps(manifest.get('model_calls', {}))}`", "",
                  manifest.get("limitation", "完整状态与错误见 manifest.json。"), "",
                  "原始分数、输入哈希、跳过原因与模型配置见同目录 manifest.json 及框架产物。"])
    (out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def verified_context(row):
    answer = row.get("answer") or {}
    snapshot = answer.get("evidence_snapshot") or {}
    if snapshot.get("schema_version") != 1 or snapshot.get("trace_id") != answer.get("trace", {}).get("trace_id"):
        return None
    keys = ["index", "citation_id", "title", "heading_path", "document_version", "content"]
    evidence = [{key: c[key] for key in keys} for c in snapshot.get("citations", [])]
    actual = hashlib.sha256(json.dumps(evidence, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return snapshot.get("citations") if actual == snapshot.get("evidence_sha256") else None


def export_datasets(report, corpus, chunks, references, out):
    if not report.get("valid"):
        raise ValueError("输入报告无效；请先修复环境漂移或中断")
    # Verify the frozen original text, rather than trusting model-provided source IDs.
    identities = [{"doc_id": d["doc_id"], "title": d["title"], "content": d["content"],
                   "visibility": d.get("visibility", "private"), "source_type": d.get("source_type", "article"),
                   "team_id": d.get("team_id"), "tags": d.get("tags", [])} for d in corpus]
    if digest(identities) != report.get("corpus_sha256"):
        raise ValueError("语料与输入报告的冻结哈希不符")
    public_ids = {d["doc_id"] for d in corpus if d.get("visibility") == "public"}
    public_chunks = [c for c in chunks if c["doc_id"] in public_ids]
    chunk_ids = {c["chunk_id"] for c in public_chunks}
    queries, qrels, samples, sample_ids, skipped = [], [], [], [], []
    normalize = lambda value: "".join(value.split()).casefold()
    for row in report["cases"]:
        case_id = row["case_id"]
        scope = row.get("scope", {})
        # MTEB is an offline model benchmark, not an authenticated ACL test.
        if scope.get("public") and not scope.get("private") and not scope.get("team"):
            labels = {}
            if row.get("chunk_qrels"):
                for label in row["chunk_qrels"]:
                    if label["chunk_id"] not in chunk_ids or label["score"] not in [0, 1, 2, 3]:
                        raise ValueError(f"无效 Chunk 标注：{case_id}")
                    labels[label["chunk_id"]] = label["score"]
            else:
                for group in row.get("evidence_groups", []):
                    group_hit = False
                    for alt in group["alternatives"]:
                        source = [c for c in public_chunks if c["doc_id"] == alt["doc_id"]]
                        if not alt.get("quotes") or not all(any(normalize(q) in normalize(c["content"]) for c in source) for q in alt["quotes"]):
                            continue
                        matching = [c for c in source if any(normalize(q) in normalize(c["content"]) for q in alt["quotes"])]
                        for chunk in matching:
                            labels[chunk["chunk_id"]] = 1
                            group_hit = True
                    if not group_hit:
                        raise ValueError(f"必要证据无法映射到完整 Chunk，请补充人工 chunk_qrels：{case_id}/{group['id']}")
            if any(score > 0 for score in labels.values()):
                queries.append({"_id": case_id, "text": row["query"]})
                qrels.extend({"query-id": case_id, "corpus-id": cid, "score": score} for cid, score in labels.items())
            else:
                skipped.append({"case_id": case_id, "stage": "mteb", "reason": "缺少 Chunk 级证据标注"})
        else:
            skipped.append({"case_id": case_id, "stage": "mteb", "reason": "权限或拒答场景由 LiveDoc 专项评测处理"})
        context = verified_context(row)
        reference = references.get("cases", {}).get(case_id)
        if reference and reference.get("query") != row["query"]:
            raise ValueError(f"参考答案对应问题不符：{case_id}")
        if (row.get("status") == "completed" and context and reference and reference.get("reference", "").strip()
            and row.get("expected_behavior", "answer") != "abstain"
            and (row.get("answer", {}).get("evidence_snapshot") or {}).get("model_called") is not False
            and not any(text in row["answer"]["answer"] for text in ["未查询到相关依据", "无法作答"])):
            samples.append({"user_input": row["query"], "response": row["answer"]["answer"],
                            "retrieved_contexts": [c["content"] for c in context], "reference": reference["reference"]})
            sample_ids.append(case_id)
        else:
            skipped.append({"case_id": case_id, "stage": "ragas", "reason": "无有效回答、实际证据或冻结参考答案"})
    task_dir = out / "retrieval"
    task_dir.mkdir(parents=True, exist_ok=True)
    # Passage already contains the production title/path; do not prepend the title twice.
    write_jsonl(task_dir / "corpus.jsonl", [{"_id": c["chunk_id"], "text": c["passage"]} for c in public_chunks])
    write_jsonl(task_dir / "queries.jsonl", queries)
    write_jsonl(task_dir / "qrels.jsonl", qrels)
    write_json(out / "chunks.json", chunks)
    write_json(out / "ragas.json", samples)
    return {"chunk_count": len(public_chunks), "retrieval_queries": len(queries), "ragas_samples": len(samples),
            "ragas_case_ids": sample_ids, "skipped": skipped, "reference_status": references.get("annotation_status"),
            "limitation": "合成小题集用于接入验收；MTEB 公共语料模型评测与 LiveDoc 权限评测分开，不代表线上准确率。"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--corpus", default="evals/protocol_corpus.jsonl")
    parser.add_argument("--references", default="evals/protocol_references.json")
    parser.add_argument("--out", required=True)
    parser.add_argument("--stage", choices=["all", "export", "mteb", "ragas"], default="all")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--metrics", choices=["core", "full"], default="full")
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--allow-partial", action="store_true", help="保留单项失败和有效指标，不把部分结果标为完整成功")
    args = parser.parse_args()
    os.chdir(ROOT)
    os.environ.update({"HF_HUB_DISABLE_TELEMETRY": "1", "RAGAS_DO_NOT_TRACK": "true", "DO_NOT_TRACK": "1",
                       "OTEL_SDK_DISABLED": "true", "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1"})
    if args.top_k < 1 or not 1 <= args.batch_size <= 4:
        raise ValueError("top-k 必须为正数，batch-size 必须在1至4之间")
    out = Path(args.out).resolve()
    if (out / "manifest.json").exists():
        raise ValueError("框架运行使用新的 out 目录；不能覆盖既有实验")
    out.mkdir(parents=True, exist_ok=True)
    versions = {name: importlib.metadata.version(name) for name in ["evalscope", "mteb", "ragas"]}
    expected = {"evalscope": "1.13.0", "mteb": "2.26.12", "ragas": "0.4.3"}
    if versions != expected:
        raise ValueError(f"框架版本不符，请按 requirements-frameworks.txt 安装：{versions}")
    report, references = read_json(args.report), read_json(args.references)
    corpus = [json.loads(line) for line in Path(args.corpus).read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    token = secrets.token_hex(32)
    environment = {**os.environ, "LIVEDOC_EVAL_BRIDGE_TOKEN": token}
    bridge_log = (out / "bridge.log").open("w", encoding="utf-8")
    bridge = subprocess.Popen([shutil.which("node") or "node", "--import", "tsx", "scripts/evaluation-model-bridge.ts"],
                              cwd=ROOT, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=bridge_log,
                              text=True, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    manifest = {"versions": versions, "input_report_sha256": digest(report), "corpus_sha256": digest(corpus),
                "references_sha256": digest(references), "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "stage": args.stage, "metric_set": args.metrics, "batch_size": args.batch_size,
                "prompt_language": "english", "allow_partial": args.allow_partial, "ragas_max_tokens": 8192,
                "adapter_sha256": hashlib.sha256((ROOT / 'evals/evalscope_compat.py').read_bytes()).hexdigest(), "status": "starting"}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        while True:
            line = bridge.stdout.readline()
            if not line:
                raise RuntimeError("本地模型适配器启动失败，见 bridge.log")
            if line.startswith("LIVEDOC_EVAL_BRIDGE="):
                port = json.loads(line.split("=", 1)[1])["port"]
                break
        base = f"http://127.0.0.1:{port}"

        def call(path, body=None):
            data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
            request = urllib.request.Request(base + path, data=data,
                                             headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            with opener.open(request, timeout=180) as response:
                return json.load(response)

        metadata = call("/metadata")
        if metadata["config_fingerprint"] != report["environment"]["config_fingerprint"]:
            raise ValueError("本地模型配置与回答报告不一致，请重新采集或使用对应配置")
        chunks = call("/prepare-corpus", {"documents": corpus})["chunks"]
        manifest.update(export_datasets(report, corpus, chunks, references, out))
        manifest["models"] = {k: v for k, v in metadata.items() if k != "calls"}
        manifest["status"] = "running"
        write_json(out / "manifest.json", manifest)
        if args.stage != "export":
            from evalscope.run import run_task
            api_base = base + "/v1"
            if args.stage in ["all", "mteb"]:
                if not manifest["retrieval_queries"]:
                    raise ValueError("没有可用的 Chunk qrels，不能生成 MTEB 分数")
                # Official EvalScope builds the real MTEB custom task and API encoder/reranker.
                run_task(task_cfg={"eval_backend": "RAGEval", "work_dir": str(out / "evalscope-mteb"), "eval_config": {
                    "tool": "MTEB", "models": [
                        {"model_name": metadata["embedding_model"], "api_base": api_base, "api_key": token,
                         "max_seq_length": 0, "dimensions": metadata["dimensions"], "encode_kwargs": {"batch_size": 8}},
                        {"model_name": metadata["rerank_model"], "is_cross_encoder": True, "api_base": api_base,
                         "api_key": token, "max_seq_length": 0, "encode_kwargs": {"batch_size": 8}}],
                    "eval": {"custom_tasks": [{"name": "LiveDocPublicChunks", "data_path": str(out / "retrieval")}],
                             "hub": "huggingface", "output_folder": str(out / "mteb"), "top_k": args.top_k, "overwrite_results": True}}})
                manifest["mteb"] = collect_mteb_scores(out)
            if args.stage in ["all", "ragas"]:
                if not manifest["ragas_samples"]:
                    raise ValueError("没有有效的回答、证据和参考答案，不能计算 RAGAS")
                from evalscope_compat import ragas_metric_clients
                metrics = ["Faithfulness", "FactualCorrectness"] if args.metrics == "core" else ["Faithfulness", "AnswerRelevancy", "ContextPrecision", "ContextRecall", "FactualCorrectness"]
                with ragas_metric_clients():
                    run_task(task_cfg={"eval_backend": "RAGEval", "work_dir": str(out / "evalscope-ragas"), "eval_config": {
                        "tool": "RAGAS", "eval": {"testset_file": str(out / "ragas.json"),
                        "critic_llm": {"model_name": metadata["judge_model"], "api_base": api_base, "api_key": token, "max_tokens": 8192},
                        "embeddings": {"provider": "openai", "model_name_or_path": metadata["embedding_model"], "api_base": api_base, "api_key": token},
                        "metrics": metrics,
                        "batch_size": args.batch_size, "raise_exceptions": not args.allow_partial}}})
                manifest["ragas_client_adapter"] = "LangchainLLMWrapper + LangchainEmbeddingsWrapper"
                score_keys = ["faithfulness", "factual_correctness(mode=f1)"] if args.metrics == "core" else None
                details = collect_ragas_details(out, manifest["ragas_samples"], score_keys)
                manifest.update(ragas_metrics=details['metrics'], ragas_score_counts=details['counts'], ragas_complete_samples=details['complete_samples'],
                    ragas_failed_scores=[{'case_id': manifest['ragas_case_ids'][i], 'metric': key} for i, key in details['invalid']])
                if details['invalid'] and not args.allow_partial:
                    raise ValueError(f"RAGAS 缺少有效分数：{details['invalid']}")
        manifest["model_calls"] = call("/metadata")["calls"]
        manifest["status"] = "completed_with_errors" if manifest.get('ragas_failed_scores') else "completed"
    except Exception as error:
        manifest["status"] = "failed"
        manifest["error"] = type(error).__name__ + ": " + str(error).replace(token, "[LOCAL_SESSION]")[:1500]
        raise
    finally:
        try:
            manifest["model_calls"] = call("/metadata")["calls"]
        except (NameError, OSError):
            pass
        write_json(out / "manifest.json", manifest)
        write_summary(out, manifest)
        if bridge.stdin:
            bridge.stdin.close()
        try:
            bridge.wait(timeout=15)
        except subprocess.TimeoutExpired:
            bridge.kill()
            bridge.wait()
        bridge_log.close()
        # Third-party task logs may contain the disposable local token; never retain it.
        for path in out.rglob("*"):
            if path.is_file() and path.suffix in [".json", ".jsonl", ".log", ".yaml", ".yml"]:
                try:
                    text = path.read_text(encoding="utf-8")
                    if token in text:
                        path.write_text(text.replace(token, "[LOCAL_SESSION]"), encoding="utf-8")
                except (UnicodeError, OSError):
                    pass
    print(json.dumps({"output": str(out), **manifest}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
