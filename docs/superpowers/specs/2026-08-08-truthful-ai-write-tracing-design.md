# AI 写作链路真实追踪设计

## 目标

把 AI 写作中的“真实知识检索”和“直接使用编辑器上下文”建模为两种明确的执行链路，消除伪造的 hybrid 检索 trace、相关性分数和检索指标，同时同步修正前端展示与监控聚合。

## 范围

本次修改覆盖：

- NestJS AI 写作准备阶段的 trace、上下文来源和响应契约。
- `rag_traces` 中编辑任务的记录入口与指标聚合口径。
- React 前端的 API 类型、流式事件消费和 trace 展示。
- 后端回归测试及前端类型检查。

本次不引入新的数据库表，不重做长文档分层摘要，也不修改真实向量检索、关键词检索、RRF、重排和压缩算法。

## 核心模型

保留现有 `RetrievalTrace`，它只描述确实执行过检索的链路。新增以下模型：

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

`RetrievalTrace` 不增加 `mode: 'none'`，也不为编辑任务填充零候选字段。判别字段保证调用方必须明确处理两种链路。

## 后端数据流

`AiWriterService.prepare` 在进入工具选择前记录总开始时间，并分别测量工具选择、会话记忆读取和编辑器来源构建耗时。

编辑类意图按以下优先级选择上下文来源：

1. 非空选中文本：`selection`。
2. 非空当前文档：`document`。
3. 非空光标前后文：`cursor`。
4. 都为空：不生成来源，`source_kind` 为 `none`。

来源内容继续受 12000 字符上限约束，但必须记录 `input_chars`、`used_chars` 和 `truncated`。这些来源通过内部 `PromptSource` 进入 prompt，不再转换为 `Citation`，不再产生 `score`、`document_version`、`chunk_id` 等虚构字段。

知识检索和当前文档检索仍返回真实 citations。AI 写作层在其 `RetrievalTrace` 外增加 `kind: 'retrieval'` 与 `retrieval_performed: true`，形成 `RetrievalExecutionTrace`。传入检索服务的 `preprocessingMs` 改为检索调用前真实经过的准备时间，而不是只使用 `toolCall.selection_ms`。

## API 契约

非流式响应保留已有 `trace` 字段，但类型改为 `AiWriteTrace`，并增加：

```ts
retrieval_trace: RetrievalTrace | null;
context_sources: EditorContextSource[];
citations: Citation[];
```

编辑任务的 `retrieval_trace` 为 `null`、`citations` 为空、`context_sources` 包含实际使用的编辑器来源。真实检索任务的 `retrieval_trace` 有值、`context_sources` 为空。

流式 `meta` 事件返回：

```ts
execution_trace: AiWriteTrace;
retrieval_trace: RetrievalTrace | null;
context_sources: EditorContextSource[];
citations: Citation[];
retrieved_document_count: number;
```

`tool_result` 和 `done` 事件保留 `has_evidence`，其含义严格限定为“存在真实检索证据”；新增 `has_context` 表示存在编辑器上下文或检索证据。编辑任务不得通过伪 citation 把 `has_evidence` 置为 true。

## Prompt 构建

新增内部 `PromptSource` 联合类型，统一渲染编辑器来源和检索 citation：

- 编辑器来源只展示来源类别、标题、截断状态和内容。
- 检索来源保留引用序号、可见性、版本、位置和内容。
- 只有知识问答任务要求模型输出 `[1]`、`[2]` 引用标记。

编辑类任务即使没有上下文也允许进入生成阶段；知识类任务仍按真实 citations 是否为空执行无证据拒答。

## 可观测性

新增 `recordEditorOperation`，编辑任务不再调用 `recordSearch`。该方法仍使用现有 `rag_traces` 存储，以避免数据库迁移，但写入：

- `entrypoint = 'editor_context'`
- `mode = 'none'`
- `retrieval_ms = 0`
- `citation_count = 0`
- payload 中保存 `EditorContextTrace` 和不含正文的来源摘要

`recordCompletion` 保持通过 `trace_id` 更新统一操作记录。

监控快照将记录分为：

- 检索事件：`entrypoint !== 'editor_context'`。
- 编辑事件：`entrypoint === 'editor_context'`。

`search_count`、`evidence_completion_count`、`no_evidence_rate`、检索 P50/P95 和 adoption rate 只基于检索事件。新增 `editor_operation_count`。生成耗时与总体错误率继续基于所有完成的 AI 写作操作。

## 前端行为

前端 `AiWriteMeta` 和 `AiWriteResponse` 使用 `AiWriteTrace` 联合类型。

- `kind === 'retrieval'`：展示召回数、RRF、重排和检索总耗时。
- `kind === 'editor_context'`：展示“使用编辑器上下文”、来源类型、是否截断和准备总耗时。
- 来源区域对真实检索显示 citations，对编辑任务显示 context sources。
- 不再把编辑器上下文计为 `retrievedDocumentCount` 或 `hasEvidence`。

## 错误处理与兼容性

已有顶层 `trace` 和 `retrieval_trace` 字段名称保留，降低现有调用方迁移成本；前端与后端在同一修改中同步升级类型。`retrieval_trace` 对编辑任务从伪对象变为 `null`，这是有意的契约收紧。

编辑上下文 trace 写入失败沿用现有观测写入失败策略，本次不改变生成请求与观测系统之间的故障耦合。数据库已有记录无需回填；新指标从部署后的事件开始按正确口径计算。

## 测试与验收

后端测试必须验证：

- 编辑任务返回 `kind: 'editor_context'`、`retrieval_performed: false` 和 `retrieval_trace: null`。
- 编辑任务 citations 为空，context source 不包含分数、chunk ID 或文档版本。
- 长编辑器内容正确报告截断长度。
- 编辑任务只增加 `editor_operation_count`，不增加 `search_count`，也不改变检索延迟和无证据率。
- 知识检索和当前文档检索仍返回 `kind: 'retrieval'` 与真实 retrieval trace。
- SSE 事件顺序保持 `tool_call -> tool_result -> meta -> delta -> done`。

前端通过 TypeScript 类型检查和生产构建验证两种 trace 分支均被安全处理。后端通过针对性 Jest 测试、完整 Jest 测试、`type-check` 和 `build` 验证。
