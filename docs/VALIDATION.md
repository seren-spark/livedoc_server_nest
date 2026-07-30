# Validation and cutover gate

## Verified in the current checkout

- `npm run type-check`: passed.
- `npm test`: 39/39 passed. This includes the Python suite's original 34 behavior areas plus Nest-specific regressions for active-job coalescing, running-job cancellation, access-field reindexing, Jieba/hash token boundaries and SSE cancellation.
- `npm run build`: passed.
- API process smoke: `GET /health` returned `200` on `127.0.0.1:8001`.
- `npm run validate:evals`: confirmed the shared Python baseline assets contain 18 corpus documents and 60 cases.
- `npm run diff:contracts`: with Python on `8000` and Nest on `8001`, 21 memory/hash/heuristic checks passed for health/auth shapes, seed output, citation content and chunk IDs, stable trace fields, unknown-field `422`, SSE ordering, and document create/update/delete behavior.
- Python and frontend repositories remained unchanged.

## Not yet verified

- Docker integration: Docker Desktop engine was unavailable during this implementation run.
- MySQL migration and lease/retry behavior against a live MySQL 8.4 container.
- Qdrant named dense/sparse collection behavior against a live Qdrant 1.15 container.
- Model download and real BGE embedding/reranker inference through Transformers.js Worker Thread.
- Real OpenAI-compatible Function Calling and streamed generation.
- Real-service Python vs Nest differential run with MySQL, Qdrant, Transformers.js BGE and an LLM provider.
- Real 18-document/60-question metric comparison and human factuality review.

## Required cutover sequence

1. Start Docker Desktop and run `docker compose up -d`.
2. Configure `.env`, including a real LLM key and endpoint.
3. Run API and worker; seed/reindex `article_chunks_nest_v1`.
4. Re-run unit, Supertest, MySQL/Qdrant integration and `npm run diff:contracts` while Python runs on `8000` and Nest runs on `8001`; the existing passing run only covers smoke adapters.
5. Run the same 18/60 evaluation. Permission leak rate must be `0`; core retrieval metrics may not drop by more than absolute `0.03` from the Python baseline.
6. Manually review citations, SSE ordering, cancellation and no-evidence behavior.
7. Only then change the frontend default base URL.

Until steps 1-6 pass, the accurate status is **structure/smoke verified, real-service parity pending**.
