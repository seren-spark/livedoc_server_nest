# Truthful AI Write Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate editor-context execution from real retrieval so API responses, UI labels, and RAG metrics report only work that actually happened.

**Architecture:** Add a discriminated `AiWriteTrace` union and a truthful `EditorContextSource`, then let `AiWriterService` return real citations only for retrieval. Store editor operations through a dedicated observability entrypoint and exclude them from retrieval metrics while retaining common completion tracking. Update the React client to render the union explicitly.

**Tech Stack:** TypeScript, NestJS, Jest, React, Vite

---

### Task 1: Define truthful trace and editor source models

**Files:**
- Modify: `src/common/types.ts`
- Modify: `src/ai/ai-writer.service.ts`
- Create: `tests/ai-writer-trace.spec.ts`

- [ ] **Step 1: Write the failing source-model tests**

Create `tests/ai-writer-trace.spec.ts` with tests that call the wished-for exported `buildEditorContextSource` API:

```ts
import { buildEditorContextSource } from '../src/ai/ai-writer.service.js';

test('editor source reports selection provenance without retrieval metadata', () => {
  const source = buildEditorContextSource(requestWithSelection('原文'));
  expect(source).toMatchObject({
    kind: 'selection',
    content: '原文',
    input_chars: 2,
    used_chars: 2,
    truncated: false,
  });
  expect(source).not.toHaveProperty('score');
  expect(source).not.toHaveProperty('chunk_id');
  expect(source).not.toHaveProperty('document_version');
});

test('editor source reports truncation at the prompt limit', () => {
  const source = buildEditorContextSource(requestWithDocument('文'.repeat(12_001)));
  expect(source).toMatchObject({
    kind: 'document',
    input_chars: 12_001,
    used_chars: 12_000,
    truncated: true,
  });
  expect(source?.content).toHaveLength(12_000);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm test -- tests/ai-writer-trace.spec.ts`

Expected: FAIL because `buildEditorContextSource` and the new source model do not exist.

- [ ] **Step 3: Add the source and trace types**

Add to `src/common/types.ts`:

```ts
export interface EditorContextSource {
  kind: 'selection' | 'document' | 'cursor';
  title: string;
  content: string;
  input_chars: number;
  used_chars: number;
  truncated: boolean;
}

export interface EditorContextTrace {
  kind: 'editor_context';
  trace_id: string;
  retrieval_performed: false;
  source_kind: EditorContextSource['kind'] | 'none';
  input_chars: number;
  used_chars: number;
  truncated: boolean;
  tool_selection_ms: number;
  memory_ms: number;
  context_build_ms: number;
  total_ms: number;
}

export interface RetrievalExecutionTrace extends RetrievalTrace {
  kind: 'retrieval';
  retrieval_performed: true;
}

export type AiWriteTrace = EditorContextTrace | RetrievalExecutionTrace;
```

Replace `buildEditorCitations` with `buildEditorContextSource(request): EditorContextSource | null`. Preserve selection/document/cursor priority, cap content at 12000 characters, and derive all length/truncation fields from the selected source.

- [ ] **Step 4: Run the source tests and verify GREEN**

Run: `npm test -- tests/ai-writer-trace.spec.ts`

Expected: the source provenance and truncation tests pass.

### Task 2: Return editor execution separately from retrieval

**Files:**
- Modify: `src/ai/ai-writer.service.ts`
- Modify: `tests/ai-writer-trace.spec.ts`
- Modify: `tests/parity.e2e.spec.ts`

- [ ] **Step 1: Write failing service-contract tests**

Instantiate `AiWriterService` with injected Jest stubs for retrieval, memory, LLM, tools, and observability. Call `complete` for `correct_text` and assert:

```ts
expect(result.trace).toMatchObject({
  kind: 'editor_context',
  retrieval_performed: false,
  source_kind: 'selection',
});
expect(result.retrieval_trace).toBeNull();
expect(result.citations).toEqual([]);
expect(result.context_sources).toHaveLength(1);
expect(observability.recordSearch).not.toHaveBeenCalled();
expect(observability.recordEditorOperation).toHaveBeenCalledTimes(1);
```

Add a retrieval case whose stub returns a real `RetrievalTrace` and assert `kind: 'retrieval'`, `retrieval_performed: true`, a non-null `retrieval_trace`, real citations, and no editor sources.

- [ ] **Step 2: Run the service-contract tests and verify RED**

Run: `npm test -- tests/ai-writer-trace.spec.ts`

Expected: FAIL because responses still expose a fabricated `RetrievalTrace`, fake citations, and no `recordEditorOperation` call.

- [ ] **Step 3: Implement the discriminated execution flow**

In `AiWriterService.prepare`:

- Record `prepareStarted`, `memoryStarted`, and `contextBuildStarted` with `performance.now()`.
- Build one `EditorContextSource` for editor intents and create `EditorContextTrace` without retrieval fields.
- Keep editor `citations` empty and populate `contextSources`.
- Wrap real retrieval traces as `{ ...result.trace, kind: 'retrieval', retrieval_performed: true }`.
- Pass elapsed preparation time to retrieval as `preprocessingMs`.
- Call `recordEditorOperation` only for editor intents.

Return from `prepare`:

```ts
{
  prompt,
  citations,
  contextSources,
  intent,
  toolCall,
  trace,
  retrievalTrace,
}
```

Update non-stream and SSE responses so `retrieval_trace` is `null` for editor tasks, `execution_trace` is always present in SSE meta, and `has_context` is independent from `has_evidence`.

Render editor context directly in `buildRagPrompt`; render citation indices and retrieval metadata only for real citations.

- [ ] **Step 4: Run contract and SSE tests and verify GREEN**

Run: `npm test -- tests/ai-writer-trace.spec.ts tests/parity.e2e.spec.ts`

Expected: editor/retrieval contract tests pass and SSE event order remains unchanged.

### Task 3: Separate editor operations from retrieval metrics

**Files:**
- Modify: `src/observability/observability.service.ts`
- Modify: `tests/ai-writer-trace.spec.ts`

- [ ] **Step 1: Write the failing metrics test**

Create an in-memory `ObservabilityService`, record one editor operation and completion, then call `snapshot`:

```ts
expect(snapshot).toMatchObject({
  search_count: 0,
  editor_operation_count: 1,
  evidence_completion_count: 0,
  no_evidence_rate: 0,
  p50_latency_ms: 0,
  p95_latency_ms: 0,
});
```

Record a real search afterward and assert that retrieval counts and latency derive only from that record.

- [ ] **Step 2: Run the metrics test and verify RED**

Run: `npm test -- tests/ai-writer-trace.spec.ts`

Expected: FAIL because `recordEditorOperation` and `editor_operation_count` do not exist and snapshots include every trace in retrieval metrics.

- [ ] **Step 3: Implement editor operation persistence and metric partitioning**

Add `recordEditorOperation(trace, context, query, sources)` that persists a record with:

```ts
{
  entrypoint: 'editor_context',
  mode: 'none',
  retrieval_ms: 0,
  citation_count: 0,
  payload: {
    trace,
    context_sources: sources.map(({ content, ...metadata }) => metadata),
  },
}
```

Extract common record insertion so `recordSearch` and `recordEditorOperation` use the same database/in-memory write path.

In `snapshot`, partition by `entrypoint === 'editor_context'`. Calculate search count, evidence/no-evidence, adoption, and retrieval percentiles from retrieval records only. Add `editor_operation_count`; keep completion count, generation percentiles, and error rate based on all completed operations.

- [ ] **Step 4: Run the metrics tests and verify GREEN**

Run: `npm test -- tests/ai-writer-trace.spec.ts`

Expected: editor operations are visible but do not alter any RAG metric.

### Task 4: Update the React client contract and trace display

**Files:**
- Modify: `E:/LiveDoc/livedoc/src/api/rag.ts`
- Modify: `E:/LiveDoc/livedoc/src/components/Knowledge/RagChatPanel.tsx`

- [ ] **Step 1: Update the frontend types as a compile-time RED test**

Add `EditorContextSource`, `EditorContextTrace`, `RetrievalExecutionTrace`, and `AiWriteTrace` to `src/api/rag.ts`. Change `AiWriteMeta` to:

```ts
export interface AiWriteMeta {
  intent: string;
  tool_call: AgentToolCall;
  execution_trace: AiWriteTrace;
  retrieval_trace: RetrievalTrace | null;
  context_sources: EditorContextSource[];
  citations: Citation[];
  retrieved_document_count: number;
}
```

Add `has_context` to tool-result and done handler types. Change non-stream `trace` to `AiWriteTrace` and add `retrieval_trace` plus `context_sources`.

- [ ] **Step 2: Run frontend type-check and verify RED**

Run: `npm run type-check`

Expected: FAIL where `RagChatPanel` still assumes every trace has retrieval candidate fields and does not store context sources.

- [ ] **Step 3: Render both trace variants**

Change the turn model in `RagChatPanel.tsx` to store `AiWriteTrace` and `EditorContextSource[]`. On meta, assign `execution_trace` and `context_sources`.

Render:

```tsx
{turn.trace?.kind === 'retrieval' ? (
  <>{/* existing recall, RRF, rerank, total time */}</>
) : turn.trace?.kind === 'editor_context' ? (
  <>
    <span>使用编辑器上下文</span>
    <span>{editorSourceLabel(turn.trace.source_kind)}</span>
    {turn.trace.truncated && <span>内容已截断</span>}
    <strong>{turn.trace.total_ms.toFixed(0)} ms</strong>
  </>
) : null}
```

Use real citations for retrieval source cards and editor context sources for editor source cards. Do not increment retrieved document count for editor sources.

- [ ] **Step 4: Run frontend type-check and build and verify GREEN**

Run: `npm run type-check`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

### Task 5: Full verification

**Files:**
- Verify all modified files

- [ ] **Step 1: Run backend focused tests**

Run: `npm test -- tests/ai-writer-trace.spec.ts tests/parity.e2e.spec.ts`

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run the complete backend suite**

Run: `npm test`

Expected: PASS with zero failed suites.

- [ ] **Step 3: Run backend static verification**

Run: `npm run type-check`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Run frontend static verification**

Run: `npm run type-check`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Inspect the final diff**

Run `git diff --check` and inspect diffs in both repositories. Confirm only the planned trace, observability, tests, frontend contract, and UI branches changed, while pre-existing user edits remain intact.
