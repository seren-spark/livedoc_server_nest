# RAG Reference Audit

Audit date: 2026-08-10

## Scope

This audit is intentionally resume-oriented. LiveDoc borrows only the behaviors that support two demo stories:

- traceable knowledge-base retrieval with source navigation;
- visible Function Call tool execution with SSE preview and user-confirmed insertion.

It does not adopt GraphRAG, multi-agent orchestration, Kafka, Kubernetes, MinIO, or a workflow canvas.

## Access Status

GitHub CLI installation is still blocked because `choco install gh -y` was denied by the external approval service with HTTP 503. This did not block source review: the repositories requested on 2026-08-10 were inspected through the GitHub connector and public shallow clones. The commit SHAs below are the exact revisions audited. No source was copied into LiveDoc.

## infiniflow/ragflow

Reference: https://github.com/infiniflow/ragflow

Observed behavior worth borrowing:

- document understanding before retrieval, not treating every file as plain text;
- explainable chunking and visual chunk inspection;
- grounded citations and quick reference review;
- reranking and dependency health checks called out as product-level concerns.

LiveDoc gap before this round:

- sparse retrieval still looked like an in-memory pseudo BM25 fallback;
- chunk payload lacked stable source anchors and version-aware citation fields;
- citation validation happened too early for streaming UX.

Adopted in LiveDoc:

- chunk metadata now includes `chunk_id`, `doc_id`, `document_version`, `heading_path`, `ordinal`, `content`, and `source_anchor`;
- Qdrant collection validation requires named dense vectors plus IDF sparse vectors;
- retrieval uses dense + sparse recall, RRF fusion, BGE rerank, and context compression;
- citations are emitted after answer generation and validation, so invalid citation indexes are never shown as trusted sources.

Not adopted:

- RAGFlow's broad enterprise ingestion surface and full platform workflow. LiveDoc only needs Markdown/PDF/DOCX for a focused interview demo.

## langgenius/dify

Reference: https://github.com/langgenius/dify

Observed behavior worth borrowing:

- agent/workflow execution state is visible to users;
- model and tool configuration are explicit;
- self-hosting depends on clear environment configuration.

LiveDoc gap before this round:

- tool selection could silently fall back to rule routing;
- SSE events mixed metadata and citations;
- front-end process display was too implicit for interview explanation.

Adopted in LiveDoc:

- four public Function Call tools only: `search_knowledge_base`, `summarize_current_document`, `continue_paragraph`, `optimize_format`;
- tool arguments use DTO validation and strict retrieval-domain checks;
- SSE protocol is `meta`, `tool_start`, `tool_result`, `delta`, `citations`, `done`, `error`;
- local real mode rejects `AGENT_TOOL_SELECTION=auto` as a hidden fallback path.

Not adopted:

- Dify's full visual workflow builder and plugin system. That would distract from an AI front-end candidate story.

## Mintplex-Labs/anything-llm

Reference: https://github.com/Mintplex-Labs/anything-llm

Observed behavior worth borrowing:

- local-first RAG experience;
- workspace/document-centered interaction;
- source cards and streaming answers as first-class UX.

LiveDoc gap before this round:

- citation cards could show source text but did not reliably reopen the versioned source;
- generated content could be inserted without a strong distinction between evidence availability and insertability;
- mock data and fake UX entries made local demos less credible.

Adopted in LiveDoc:

- citation cards can open the matching knowledge document, carry `citation_id/source_anchor/chunk_id/document_version`, stop auto-location when the document version changed, and locate the saved source with a snippet probe;
- `has_evidence` now means persisted knowledge-base evidence only;
- `can_insert` independently controls whether the preview can be written into TipTap;
- generated Markdown is parsed through the official `@tiptap/markdown` extension and inserted as structured TipTap content after user confirmation.

Not adopted:

- AnythingLLM's broad local-agent provider surface. LiveDoc keeps one OpenAI Function Call path and one BGE/Qdrant RAG path to stay easy to explain.

## xun082/DocFlow

Audited commit: `32edc5f0507c4fec78a479d3dd18737f33c1d284`

Relevant source:

- `apps/DocFlow/src/extensions/MarkdownPaste/MarkdownPaste.ts`
- `apps/DocFlow/src/services/collaboration/index.ts`
- `apps/DocFlow/src/hooks/useDocumentEdit.ts`
- `apps/DocFlow/src/extensions/AgentSuggestion/index.ts`

Independent finding: the public repository contains the editor and collaboration client, but not the RAG backend described as a future capability in its README. It therefore provides no evidence for a parent-child retrieval design.

Adopted:

- use `mdast-util-gfm` plus `micromark-extension-gfm` so Markdown tables and other GFM blocks are parsed structurally instead of being treated as undifferentiated text;
- retain structured TipTap JSON and explicit accept/reject semantics already present in LiveDoc.

Not adopted:

- inline suggestion diff marks. They are useful editor UX, but are separate from the current RAG correctness problem and would expand the resume story.

## skygazer42/MimirQ

Audited commit: `b220f7973ab3defe9ff9276faf060d424bc2a45e`

Relevant source:

- `app/rag/retrieval/document_structure.py`
- `app/rag/retrieval/hybrid/fusion.py`
- `app/rag/retrieval/hybrid/post_process.py`
- `app/rag/evaluation/evidence_retrieve_gate.py`
- `docs/guides/retrieval_ablation.md`
- `docs/guides/evidence_retrieval_gate.md`

Worth borrowing:

- build a document outline from existing heading/chunk metadata rather than inventing another content store;
- evaluate retrieval separately from generation using chunk-level evidence, Recall/Hit/MRR/nDCG and fixed regression data;
- treat parent-child chunking as a selectable document strategy, not a universal default.

Adopted in this round:

- LiveDoc's evaluator now reports retrieval evidence coverage from returned chunk content instead of relying only on document IDs;
- chunk configuration participates in the configuration fingerprint, so a worker cannot silently publish chunks produced with different budgets;
- the final embedding passage is checked with the real BGE tokenizer before embedding.

Not adopted:

- MimirQ's large strategy matrix, GraphRAG, ColBERT, LTR, plugin DSL and multi-agent paths. They are credible platform features but disproportionate for this project.

## Snailclimb/interview-guide

Audited commit: `7bd7dbd2e83caa30ad67d6b79c4a9323f8e733ce`

Relevant source: `app/src/main/java/interview/guide/modules/knowledgebase/service/KnowledgeBaseVectorService.java`.

Worth borrowing:

- write vectors with pending job metadata, batch provider requests, then promote the successful job;
- test the real splitter behavior rather than mocking it away.

LiveDoc already has the stronger form of the first behavior: versioned points are inactive until the fenced worker atomically activates the complete version. The default Spring AI `TokenTextSplitter` used here loses Markdown heading/source-offset structure, so replacing LiveDoc's AST chunker with it would be a regression.

## via007/bilibili-rag

Audited commit: `1a2bf6b89d1b31a1d095e79f4c67088665a7c027`

Relevant source:

- `app/services/retrieval.py`
- `app/services/rag.py`
- `app/routers/chat.py`

Worth borrowing:

- deterministic weighted RRF and an optional per-source diversity cap;
- keep fusion code dependency-light and directly unit-testable.

Not adopted now:

- the generic 1000-character/200-character-overlap splitter;
- answering from general model knowledge when retrieval has no evidence;
- a hard source-diversity cap before an ablation proves it improves LiveDoc. Diversity can reduce correctness for questions whose evidence legitimately spans several chunks in one document.

## fufankeji/fufan-chat-api

Audited commit: `7f922b7e5d5ad72782b5d99e2c1712e9e8cb1c79`

Relevant source:

- `fufanrag/retriever/retriever.py`
- `fufanrag/retriever/reranker.py`
- `document_loaders/pdfloader.py`

The retriever/reranker abstraction is useful research code, but the chat configuration defaults reranking off and contains machine-specific local model paths. LiveDoc already uses the official Transformers model/tokenizer, a real BGE reranker and Qdrant IDF sparse vectors, so importing this Python layer would duplicate inference and configuration rather than improve it.

## wzdavid/ThinkRAG

Audited commit: `85ebd7856ab00b47c6ae3ce67d2389d4cf2bc081`

Relevant source:

- `server/retriever.py`
- `server/index.py`
- `server/models/reranker.py`

Worth borrowing:

- expose chunk size/overlap as real configuration;
- prefer the framework's fusion retriever to ad-hoc score normalization when using LlamaIndex.

Not adopted:

- its `SimpleHybridRetriever` concatenates vector results before BM25 results and is not true score/rank fusion;
- maintaining a separate in-process BM25 corpus. LiveDoc production search already uses Qdrant's IDF sparse vectors and RRF.

## liyupi/yu-ai-agent

Audited commit: `6d4608c58b442d470fffc7a5e0b2aedb0e9478c8`

Relevant source: `src/main/java/com/yupi/yuaiagent/rag/MyTokenTextSplitter.java`.

This is intentionally compact teaching code around Spring AI's `TokenTextSplitter`. It is easy to explain but has no heading hierarchy, stable source offsets, versioned activation or retrieval evaluation. No implementation was copied; LiveDoc keeps the same interview-friendly simplicity at the product level while retaining stronger traceability.

## NanGePlus/RagLangChainTest

Audited commit: `83aba779c82a41f90d2f97842d9177b877becc44`

Relevant source:

- `tools/pdfSplitTest_Ch.py`
- `mainReranker.py`
- `tools/pdfTableSplitTest02.py`

This repository is a useful learning walkthrough, not a production reference: model paths and credentials are edited in scripts, chunking is character-count based, and the workflow asks users to modify installed package source for compatibility. Its PDF-table experiments reinforce the need for structure-aware parsing, which LiveDoc handles through Docling plus GFM-aware Markdown chunking.

## biao994/DocPaws

Audited commit: `2cc31a42e375a47b25e8125b9df49e3da29f913b`

Relevant source:

- `backend/docpaws/api/schemas/chat.py`
- `backend/docpaws/usecases/chat_service.py`
- `backend/docpaws/domain/models/index.py`
- `backend/docpaws/infra/tasks/index_worker.py`
- `frontend/src/components/ChatMessageList.vue`

Strong parts:

- citations persist `chunk_id`, `document_id`, page and snippet snapshots;
- retrieval runs and immutable index artifacts are explicit database records;
- old stored citations can be hydrated from a chunk while preserving a stored snippet when available.

Limitations relevant to LiveDoc:

- citations have no document version or source anchor;
- the answer is returned with the retrieved citations, but citation indexes in generated text are not validated against that evidence set;
- the front-end citation card is static and cannot open or highlight the source.

Therefore DocPaws is a good reference for citation snapshot persistence and retrieval audit records, but not for exact click-through traceability. LiveDoc retains its stricter `citation_id + document_version + source_anchor + offsets` contract and version-mismatch guard.

## Citation-focused audit: eight additional repositories

The following repositories were inspected specifically for citation provenance. A repository was not considered production-grade merely because its README or UI uses the words “citation” or “traceability”. The review followed the data from ingestion metadata through retrieval, answer generation, response validation, persistence, and front-end source navigation.

### 1644156/yunwen-doc-ai-platform

Audited commit: `30d2ef5a750b50d3cc7332b33b71fac4c994b088`

Relevant source:

- `app/query_process/agent/nodes/node_answer_output.py`
- `app/query_process/page/chat.html`
- `app/import_process/agent/nodes/node_import_milvus.py`

Worth borrowing: it numbers evidence in the prompt, parses the model's `[source:N]` markers, and returns only sources whose indexes actually appear in the final answer. LiveDoc adopted the same semantic distinction in this round: retrieval candidates remain in the trace, while the public answer citation list now contains only deduplicated, validated indexes actually referenced by the model.

Limitations: invalid model indexes are silently omitted from its citation list while the answer marker can remain; the citation has no document version, stable source anchor, page/offset, or version-mismatch guard; context budgeting is character-based; reindexing deletes old vectors before inserting the replacement. LiveDoc keeps fail-closed citation validation and atomic version activation.

### wzbb66/knowledge

Audited commit: `a8249403a06bcb2ec34f0de06480e62635fdb036`

Relevant source:

- `utils/tools_config.py`
- `prompts/prompt_template_generate.txt`

This is filename-level attribution rather than structured citation provenance. Retrieval returns a text blob containing `[来源: 文件名]`; the model is asked to repeat it. There is no citation DTO, chunk identity, version, location, generated-index validation, or click-through source contract. Its in-process BM25 fallback and filename-range lookup are also weaker than Qdrant IDF sparse retrieval. Nothing was adopted.

### chenjiachen040906-lang/documind

Audited commit: `db0bbcb93a1d7b8061fd113377a6a7dfb51c5a4d`

Relevant source:

- `src/app/api/chat/route.ts`
- `src/components/ChatPanel.tsx`
- `src/app/page.tsx`
- `src/lib/utils.ts`

Worth borrowing as an interaction pattern: `[n]` markers become buttons that scroll a side-by-side PDF viewer to the cited page. LiveDoc already implements the stronger equivalent for editable Markdown: inline citation links scroll to source cards, and “原文” opens the versioned document and locates/highlights the exact offset/snippet.

Not suitable as backend reference: it stores one document in a JSON file, uses fixed character chunks and handwritten bigram keyword scoring, returns the first chunks when no keyword matches, sends every retrieval candidate as a citation before generation finishes, and does not validate generated indexes. The route also contains a hard-coded default API credential, which is a serious configuration/security defect. No code was copied.

### LiuBai200/Contract_Agent

Audited commit: `e9bf021b9402919984a687078e5de92dad4a8ee1`

Relevant source:

- `backend/schemas.py`
- `backend/agent/contract_agent.py`
- `backend/services/vector_store.py`

Its citation DTO usefully acknowledges format-specific positions: PDF page, DOCX paragraph, PPTX slide, clause title, chunk index, similarity score, and source content. This confirms that a citation contract should preserve parser-native location metadata rather than only a filename.

It is not a complete answer-citation contract: every retrieved hit is returned as a citation before the answer is inspected, the answer's citation markers are not validated, document versions and source anchors are absent, and the content-hash chunk ID is based on MD5 plus partial text. LiveDoc's parser-neutral `source_anchor + offsets + page_number` contract already covers the useful idea without adopting its weaknesses.

### genzhuoxue/rag-knowledge-base

Audited commit: `91b0874890c59584592656bb1cd16e4607b4a99b`

Relevant source:

- `backend/src/main/java/com/rag/kb/dto/ChatDtos.java`
- `backend/src/main/java/com/rag/kb/service/ChatService.java`
- `backend/src/main/java/com/rag/kb/service/IngestionService.java`
- `frontend/src/views/KbDetail.vue`

This is the strongest front-end citation reference in this group. Its DTO carries vector/document identity, chunk index, page, excerpt, URL, line range, and modality. Citation snapshots are stored with chat history. In the UI, answer `[n]` links scroll to and flash the matching citation card; users can inspect page/line metadata, previews, images, and source URLs.

LiveDoc already has equivalent inline navigation plus a stronger exact-source path: document version checking, stable anchors, AST offsets, snippet fallback and TipTap highlight. The repository's backend returns all context chunks as citations regardless of whether the model referenced them, does not validate generated citation indexes, lacks the indexed document version, derives line ranges heuristically, and can fall back to the most recent chunks when lexical retrieval misses. The UI behavior is a good design reference; its retrieval/citation correctness rules should not be copied.

### zhihua-tech/zhuatech-searchai

Audited commit: `0bc39d8621ef60946b12481f1b2664907076bec8`

Relevant source: `backend/src/main/java/cn/zhuatech/searchai/service/EnterpriseSearchService.java`.

The implementation returns a deterministic permission-aware search *plan* containing descriptive step names. It does not execute document retrieval, generation, citation construction, validation, or source navigation. The README correctly calls it a reference architecture, but it is not evidence of a working RAG citation chain. Nothing was adopted.

### cnbaowen/huojian-ai-knowledge-free

Audited commit: `d41eaca52780f7ccb6c7cd250491c1f39b805b24`

Relevant source:

- `backend/app/Services/FreeKnowledgeQaService.php`
- `backend/app/Services/ModelAnswerService.php`
- `frontend/src/views/KnowledgeChat.vue`

Useful product behaviors are explicit no-evidence refusal, persisted citation snapshots and answer feedback. However, citations are built from every retrieved match rather than markers actually used by the answer; the front end only renders static cards; the chunk schema has no version/location anchor; and an OpenAI-compatible provider failure silently falls back to local extractive logic. That fallback is intentionally incompatible with LiveDoc's real-runtime guarantee. No implementation was adopted.

### miuxuer/rag-assistant

Audited commit: `c39eb3fe6c9520efe640acf934071b047aff7ecb`

Relevant source:

- `app/rag/chain.py`
- `app/ingest/splitter.py`
- `static/index.html`

This is clear teaching code for numbered prompt context, but `sources` contains every reranked chunk, not only citations used in the generated answer. Source identity is a filename plus a process-local sequential chunk number; there is no document version, stable anchor, answer-index validation, source reopening, or highlight. Its optional GraphRAG path would add complexity without improving LiveDoc's current resume story. Nothing was adopted.

### Resulting LiveDoc rule

The audit reinforced an important terminology rule:

- **retrieved candidates** are all chunks made available to generation and belong in retrieval traces;
- **answer citations** are the validated, deduplicated subset whose `[n]` indexes actually occur in the final answer;
- **source navigation** requires a versioned document identity and exact anchor/offset or a verified snippet fallback.

LiveDoc now applies all three separately. It does not label every retrieved chunk as an answer citation.

## Parent-child Index Decision

LiveDoc does not add parent-child indexing in this round. That is deliberate, not an omission:

- current Markdown ingestion already uses heading hierarchy plus recursive sentence/line splitting;
- source offsets and versioned citation navigation are stable at the child chunk level;
- none of the current evaluation data proves that a larger parent context improves recall or grounded-answer quality;
- unconditional parent hydration increases prompt tokens and can lower reranker precision.

The next justified step is an ablation: compare the current baseline against adjacent-sibling or heading-parent hydration on chunk-level evidence metrics. Add it only if the fixed evaluation set improves without harming citation validity or latency.

## Follow-up When GitHub CLI Works

Run:

```powershell
choco install gh -y
gh auth login --hostname github.com --git-protocol https --web
gh auth status
```

Use `gh` for authenticated metadata checks and repeat the earlier RAGFlow/Dify/AnythingLLM audit at exact commits. The repositories added on 2026-08-10 already have exact shallow-clone SHAs above. Record:

- repository default branch;
- exact commit SHA;
- file paths and functions/pages inspected;
- behavior borrowed;
- LiveDoc implementation file;
- behavior intentionally not adopted and why.
