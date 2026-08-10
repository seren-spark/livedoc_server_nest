# LiveDoc RAG production-quality audit

Audit date: 2026-08-09

## Verdict

The primary resume demo path is real, runnable, and covered by a self-cleaning
real E2E. It is suitable for an AI-front-end interview demo. It should still
be described as a focused LiveDoc RAG implementation rather than a distributed
RAG platform.

## Verified path

```text
PDF/DOCX upload
  -> signature/ZIP structure validation
  -> atomic local storage + SHA-256
  -> Docling/RapidOCR parsing
  -> Markdown AST heading-aware chunking
  -> real BGE dense embedding
  -> Qdrant dense + IDF sparse recall
  -> RRF fusion
  -> real BGE reranking
  -> token-budget context compression
  -> OpenAI-compatible Function Call
  -> separated editor/evidence prompt
  -> SSE preview
  -> citation-index validation
  -> official TipTap Markdown parsing
  -> user-confirmed insertion
```

The live dependency gate passed for MySQL, Qdrant, BGE embedding, BGE
reranker, Docling/RapidOCR, and the configured OpenAI-compatible model.
The real E2E additionally passed DOCX upload, Docling 2.118 parsing, atomic
confirmation, indexing, retrieval, Function Call, grounded answer, SSE event
ordering and inserted feedback. Backend tests passed 52/52; frontend tests
passed 5/5; backend/frontend type checks and production builds passed.

## Corrections made during this audit

- The validated Function Call now determines the execution intent. A stale
  client `intent` can no longer override the tool selected by the model.
- `summarize_current_document` now receives the real document body, truncated
  with the configured tokenizer budget instead of silently summarizing only a
  title/cursor window.
- Raw editor context is no longer appended to every query variant. It remains
  a separate context channel and no longer pollutes dense and sparse recall.
- The handwritten Markdown-to-TipTap line parser was removed. Insertion and
  Markdown paste now use the official `@tiptap/markdown` extension.
- A citation-validation failure clears the streamed draft and disables
  insertion instead of leaving an invalid partial answer looking usable.
- Reranker output is displayed as an uncalibrated relevance score, not a
  misleading percentage.
- PDF/DOCX uploads now validate real signatures. DOCX central-directory
  inspection uses `yauzl` and requires the Office document entries before a
  parsing job is created.
- Editor virtual-scroll debug logging and visual overlays are disabled.
- Citation navigation first validates the exact document version, then maps
  source offsets through the official TipTap Markdown parser to a ProseMirror
  range; snippet matching is only a bounded fallback.
- Import confirmation now locks the import and atomically creates the
  document, inserts the durable index job, updates document state, links
  assets, and marks the import confirmed in one MySQL transaction.
- Runtime API/workers no longer execute DDL. `npm run db:migrate` owns schema
  mutation; normal startup verifies the required version, columns and indexes.
- OpenAI-compatible Function Call requests accept a validated JSON extension
  object. The verified Qwen setup disables thinking for forced tool choice.
- Docling/OpenBLAS thread limits are explicit and included in the worker
  configuration fingerprint to prevent local model memory spikes.

## Appropriate custom logic

These pieces should remain project code because they express LiveDoc-specific
behavior rather than reimplementing a general-purpose parser or database:

- heading-aware chunk assembly, overlap, stable chunk IDs, and source offsets;
- permission-filter construction for private/team/public scopes;
- citation DTO construction and version checks;
- token-budget evidence compression policy;
- queue lease/fencing and application-level retry policy;
- current unsaved editor-document retrieval, which intentionally stays local
  and ephemeral instead of writing every keystroke to Qdrant.

The Markdown syntax parser itself is not custom: chunking starts from
`mdast-util-from-markdown` with the maintained GFM extensions
`mdast-util-gfm` and `micromark-extension-gfm`; editor insertion uses
`@tiptap/markdown`. The local size estimator is used only to plan candidate
boundaries. Before embedding, every complete passage is measured by the real
BGE tokenizer and is re-chunked when it exceeds `CHUNK_MAX_TOKENS`, so the
embedding pipeline does not silently truncate indexed evidence.

## Remaining production gaps

### Optional - Qdrant native BM25 migration

Persistent sparse retrieval intentionally uses the maintained `@node-rs/jieba`
and `murmurhash-js` packages, Qdrant IDF, and deterministic RRF. There is no
handwritten tokenizer or fake BM25 fallback. A future Qdrant-native BM25/RRF
migration is an optimization, not a correctness requirement for this resume
scope.

Do not change the existing collection in place. A safe migration requires:

1. create `article_chunks_real_v2` with named dense and IDF sparse vectors;
2. index every active document into the new collection using
   `qdrant/bm25` with `tokenizer=multilingual` at both ingest and query time;
3. run the full retrieval evaluator against v1 and v2;
4. switch `QDRANT_COLLECTION` only after the v2 index is complete;
5. retain v1 for rollback, then remove it only through an explicit operator
   action.

This audit did not point `.env` at an empty v2 collection or delete v1.

### P2 - migration file granularity

Schema mutation is now operator-only and the runtime validates a centralized
table/column/index contract. The current baseline and compatibility repair are
still implemented in one idempotent migration service rather than one file per
historical version. Split future changes into ordered migration files when the
project needs multi-release rolling upgrades.

### P2 - evaluation and UI aggregation

- Evaluation manifests are now owned by this repository under `evals/`; the
  evaluator no longer depends on the deprecated server at runtime.
- Knowledge-space counts and some folder/team options are derived from the
  current server page, so they are not reliable global aggregates.
- Citation validation proves that displayed indexes belong to the retrieved
  set; it does not prove semantic support for every generated claim.
- The evaluator now reports returned-chunk evidence-term coverage in addition
  to document Recall/MRR/nDCG. A retained real run is still needed before
  deciding whether adjacent-sibling or parent-context hydration improves this
  corpus.
- The 18-document/60-case evaluator is implemented and its manifests validate,
  but a retained full real run is still required before claiming Recall@10,
  generation-success or latency thresholds.
- The frontend production build passes but reports legacy Sass `@import`,
  large-chunk, and `lottie-web` eval warnings outside the RAG feature.

### Parent-child indexing

Parent-child indexing is not enabled by default. LiveDoc already uses heading
hierarchy plus recursive sentence/line splitting, and no current regression
result demonstrates that unconditional parent hydration improves grounded
answers. The production-safe next step is an ablation against the current
baseline; enabling it without evidence would increase context tokens and can
reduce reranker precision.

## Environment security

The configured Qdrant probe passes, but the client reports that an API key is
being sent over an insecure HTTP connection. Use an HTTPS Qdrant endpoint (or
private local networking without a public API key) before treating the setup as
production-secure.

## Honest resume boundary

Safe to claim and demonstrate now:

- real BGE + Qdrant hybrid recall, BGE reranking, grounded citation validation,
  version-aware source reopening and offset-based paragraph highlighting;
- real Function Call tool selection, visible SSE steps, preview, and
  user-confirmed structured TipTap insertion;
- atomic import confirmation backed by a fenced durable index job;
- local startup that fails when providers or the MySQL schema contract are missing.

Do not yet claim:

- cross-service distributed transactions (Qdrant remains an asynchronous,
  version-activated side effect by design);
- Qdrant-native BM25/RRF unless the optional v2 migration is performed;
- production security while Qdrant credentials travel over HTTP;
- Recall@10 or generation-success thresholds until the real evaluator has
  produced a retained report.
