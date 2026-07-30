# API parity contract

| Contract | NestJS behavior |
|---|---|
| `GET /health` | Public; reports adapters and production guard state |
| `POST /dev/auth/login` | `200`; development only |
| `POST /dev/auth/logout` | `200`; public and token-revoking |
| `GET /dev/auth/me` | Bearer auth required |
| `POST /documents` | `202` when queued, `201` when `index_now=false` |
| `GET /documents`, `GET /documents/:doc_id` | Permission-filtered |
| `PATCH /documents/:doc_id` | Version increments for indexed-field changes |
| `DELETE /documents/:doc_id` | Cancels queued, running and retry-wait jobs; removes vectors |
| `POST /documents/:doc_id/reindex` | `202`; coalesces the same active version, otherwise creates its next generation |
| `POST /documents/index` | `202`; legacy-compatible indexing entrypoint |
| `GET /index-jobs/:job_id` | Document/job permission checked |
| `POST /knowledge/search` | `200`; dense, keyword or hybrid; server-owned query expansion |
| `POST /ai/write` | `200`; JSON or POST SSE |
| `POST /ai/feedback` | `200`; trace owner only |
| `GET /metrics/rag` | `24h`, `7d`, `30d` windows |
| `GET /metrics/rag/traces` | User + space scoped list |
| `GET /metrics/rag/traces/:trace_id` | User + space ownership |
| `POST /dev/seed` | `200`; development only |

## Permission rules

- `private`: same `space_id` and same `owner_id`.
- `team`: same `space_id` and `team_id` in authenticated `team_ids`.
- `public`: globally readable.
- Qdrant filters carry these constraints into retrieval; filtering is not deferred until after top-k.
- Every query variant reuses the same access context and scope.

## AI boundary

The Typed Tool Registry contains seven bounded tools: knowledge search, summary, continuation, selection formatting, fill-in-middle, correction and expansion. It is Function Calling orchestration, not an autonomous agent and not LangGraph.

No-evidence refusal is mandatory for knowledge QA/search. Editor transformations may proceed from explicit editor context; missing LLM configuration returns `503` instead of fabricating output.
