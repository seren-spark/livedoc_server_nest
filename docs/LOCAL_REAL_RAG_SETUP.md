# LiveDoc Local Real RAG Setup

Backend config is always loaded from:

```text
E:\LiveDoc\livedoc_server_nest\.env
```

The API, index worker, and import worker share the same `AppConfig.configFingerprint`. Jobs persist that fingerprint when they enter the queue, and workers reject jobs created with a different fingerprint.

## Current Check Result

Run from `E:\LiveDoc\livedoc_server_nest`:

```powershell
npm run config:check
npm run config:check:live
```

The live dependency gate was last verified successfully on 2026-08-09. It
executes real requests and parsing work; it does not infer readiness only from
environment variable names.

| Dependency | Current result | Configure in | Fix |
| --- | --- | --- | --- |
| OpenAI-compatible LLM | Passed: forced `livedoc_config_probe` Function Call returned a valid tool call | `.env` | Keep the API key private and use a model/tool-mode available to the configured account. |
| MySQL | Passed: `SELECT 1` plus required table/column/index contract | `.env` `DATABASE_URL` | Run `npm run db:migrate` after schema changes. API/workers validate only and never run DDL. |
| Qdrant | Passed: named dense vector size 512 and IDF sparse vector | `.env` Qdrant fields | Run `npm run qdrant:init` for a fresh instance. Use HTTPS when an API key crosses a public network. |
| BGE models | Passed: 512-dimensional non-zero embedding and valid rerank scores | `.env` model fields and `MODEL_CACHE_DIR` | Public models need no Hugging Face token; retain cache or network access. |
| Docling/RapidOCR | Passed: imports and minimal DOCX parse | `.env` `DOCLING_PYTHON` | Install the pinned `requirements-docling.txt` into the configured Python environment. |

## Required `.env`

Use real providers for normal local development:

```dotenv
APP_ENV=development
RAG_RUNTIME_MODE=real
APP_HOST=127.0.0.1
APP_PORT=8001
ALLOWED_ORIGINS=http://localhost:5173

METADATA_STORE=mysql
MEMORY_STORE=mysql
INDEX_JOB_STORE=mysql
IMPORT_JOB_STORE=mysql
OBSERVABILITY_STORE=mysql
DATABASE_URL=mysql://livedoc:livedoc_dev_password@127.0.0.1:3307/livedoc_nest

VECTOR_STORE=qdrant
QDRANT_URL=http://127.0.0.1:6335
QDRANT_API_KEY=
QDRANT_COLLECTION=article_chunks_real_v1

EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/bge-small-zh-v1.5
EMBEDDING_DIM=512
CHUNK_MAX_TOKENS=420
CHUNK_OVERLAP_TOKENS=64
SPARSE_EMBEDDING_PROVIDER=qdrant_idf

RERANK_PROVIDER=bge
RERANK_MODEL=Xenova/bge-reranker-base
MODEL_DTYPE=q8
MODEL_CACHE_DIR=data/model_cache

AGENT_TOOL_SELECTION=llm
QUERY_EXPANSION_ENABLED=true
QUERY_EXPANSION_MAX_VARIANTS=3

LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=<OpenAI API Key>
LLM_MODEL=<your available model>
LLM_TIMEOUT_SECONDS=60
# Leave `{}` for OpenAI. Qwen thinking models on Alibaba Model Studio require:
LLM_TOOL_CALL_EXTRA_BODY={}

STORAGE_PROVIDER=local
STORAGE_LOCAL_ROOT=data/storage

DOCLING_PYTHON=E:\LiveDoc\livedoc_server_nest\.venv-docling\Scripts\python.exe
DOCLING_SCRIPT=scripts/docling_parse.py
DOCLING_NUM_THREADS=1
```

## Install Dependencies

MySQL:

```sql
CREATE DATABASE livedoc_nest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'livedoc'@'%' IDENTIFIED BY 'livedoc_dev_password';
GRANT ALL PRIVILEGES ON livedoc_nest.* TO 'livedoc'@'%';
FLUSH PRIVILEGES;
```

Official docs: https://dev.mysql.com/doc/refman/8.4/en/installing.html

Qdrant:

```powershell
docker run --name livedoc-qdrant -p 6335:6333 -p 6336:6334 -v livedoc_qdrant:/qdrant/storage qdrant/qdrant:latest
npm run qdrant:init
```

`qdrant:init` is idempotent. It creates only the collection configured by
`QDRANT_COLLECTION`, with a 512-dimensional named `dense` vector, an IDF
named `sparse` vector, and the payload indexes used by LiveDoc. It never
deletes or recreates an existing collection. If the Qdrant service is on a
remote/public address and uses an API key, configure an HTTPS URL; sending an
API key to a public plain-HTTP endpoint is not secure.

Official docs: https://qdrant.tech/documentation/quickstart/

Docling and RapidOCR:

```powershell
py -3.13 -m venv E:\LiveDoc\livedoc_server_nest\.venv-docling
E:\LiveDoc\livedoc_server_nest\.venv-docling\Scripts\python.exe -m pip install -r E:\LiveDoc\livedoc_server_nest\requirements-docling.txt
```

Official docs:

- https://docling-project.github.io/docling/
- https://github.com/RapidAI/RapidOCR

BGE through Transformers.js:

```dotenv
EMBEDDING_MODEL=Xenova/bge-small-zh-v1.5
EMBEDDING_DIM=512
RERANK_MODEL=Xenova/bge-reranker-base
MODEL_DTYPE=q8
MODEL_CACHE_DIR=data/model_cache
```

Official docs:

- https://huggingface.co/docs/transformers.js/
- https://github.com/FlagOpen/FlagEmbedding

OpenAI:

```dotenv
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=<real API key>
LLM_MODEL=<model available to your account>
LLM_TOOL_CALL_EXTRA_BODY={}
```

`LLM_TOOL_CALL_EXTRA_BODY` is merged only into Function Call/query-expansion
requests, before LiveDoc's protected `model/messages/tools/tool_choice` fields.
For the currently verified Alibaba Model Studio Qwen configuration use:

```dotenv
LLM_TOOL_CALL_EXTRA_BODY={"enable_thinking":false}
```

This is necessary because Qwen thinking mode rejects forced
`tool_choice="required"`; a plain chat-completion health check alone cannot
prove Function Call compatibility.

Official docs: https://platform.openai.com/docs/

## Start and Validate

Normal local startup now runs the live config gate first:

```powershell
npm run db:migrate
npm run qdrant:init
npm run config:check:live
npm run dev
```

`npm run dev` 同时启动 API、索引 worker 和导入 worker。只运行
`npm run start:dev` 时，API 虽然可访问，但索引任务不会被消费并会一直显示
`queued`。需要单进程调试时，再分别运行 `npm run start:dev`、
`npm run worker` 和 `npm run worker:imports`。

One-command real acceptance test (it creates a unique DOCX and removes its own
document, assets, jobs, traces, feedback and Qdrant points afterward):

```powershell
npm run validate:e2e:real
```

The retained report is written to `evals/e2e-results/<run-id>.json`. The latest
verified run completed Docling parse, atomic import confirmation, BGE indexing,
Qdrant hybrid retrieval, BGE rerank, LLM Function Call, non-stream generation,
SSE generation, citation validation and `inserted` feedback.

Real RAG evaluation, after the API and both workers are running:

```powershell
npm run validate:real -- --seed-eval
```

Reports are written to `evals/results/<run-id>/` with `report.json`, `cases.jsonl`, `summary.md`, and `review.csv`. Offline evaluation does not invent adoption rate; `adoption_rate` comes only from real `inserted` feedback events.
