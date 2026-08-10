# LiveDoc NestJS Server

LiveDoc 的 TypeScript RAG 后端。本仓库默认监听 `8001`；废弃的 `../livedoc_server` 不参与运行，也不在本仓库的开发流程中修改。

> 当前验证级别：真实依赖探针已通过 MySQL schema contract、Qdrant、Transformers.js BGE embedding、BGE reranker、Docling/RapidOCR 和 OpenAI-compatible LLM；真实 E2E 已通过 DOCX 导入、原子确认、索引、混合检索、Function Call、普通/SSE 生成、引用与反馈；52 项后端测试、5 项前端引用定位测试、前后端类型检查和生产构建通过。尚未保留 60-case 全量真实评测报告，因此不能把 Recall@K、成功率或延迟门槛写成已达成指标。详见 [生产质量审计](docs/RAG_PRODUCTION_QUALITY_AUDIT.md) 和 [本地真实 RAG 配置](docs/LOCAL_REAL_RAG_SETUP.md)。

## 为什么是 NestJS + Node.js

NestJS 是运行在 Node.js 上的后端框架，不是与 Node.js 并列的第二个运行时。本项目的准确表述是：**Node.js 20 + TypeScript + NestJS + Fastify**。NestJS 提供 Module、Guard、DTO、Provider 和依赖注入，Fastify 提供 HTTP adapter，Node.js 提供运行时和 Worker Thread。

## 模块边界

- `Auth`：开发身份、PBKDF2 密码、Bearer session、Guard。
- `Documents`：权限感知的文档 CRUD、版本和索引状态。
- `DocumentImports`：PDF/DOCX 持久化导入队列、Docling 解析、图片 OCR/视觉描述、预览确认与资产生命周期。
- `Indexing`：MySQL 任务队列、事务领取、`SKIP LOCKED`、租约回收、重试与版本激活。
- `Retrieval`：Markdown AST 分块、Transformers.js embedding、Jieba + Qdrant IDF sparse、Dense + Sparse、RRF、BGE rerank、去重、压缩与引用。
- `AiWriter`：受约束 Typed Tool Registry、OpenAI-compatible Function Calling、会话记忆、普通 JSON 与 SSE。
- `Observability`：trace、feedback、检索/生成延迟、采用率和队列深度。

模型加载位于独立 Worker Thread。Qdrant 使用命名向量 `dense` / `sparse`，collection 由 `.env` 的 `QDRANT_COLLECTION` 指定。

## 验证

```powershell
npm install --cache .npm-cache
npm run config:check
npm run config:check:live
npm run type-check
npm test
npm run build
npm run validate:evals
npm run validate:e2e:real
```

正常本地运行固定读取项目根目录 `.env`，并要求 `RAG_RUNTIME_MODE=real`。缺少真实 provider、模型、数据库、Qdrant 或 LLM 配置时启动失败；memory/hash/heuristic 仅允许隔离测试注入。演示账户密码均为 `Demo@123456`：

- `alice@livedoc.local`：`team_alpha`
- `bob@livedoc.local`：`team_alpha`
- `carol@livedoc.local`：`team_beta`

## 本地真实组件路径

1. 按 [LOCAL_REAL_RAG_SETUP.md](docs/LOCAL_REAL_RAG_SETUP.md) 配置项目根目录 `.env`。
2. 执行 `npm run db:migrate`、`npm run qdrant:init` 和 `npm run config:check:live`。
3. 本地开发执行 `npm run dev`，一次启动 API、索引 worker 和导入 worker。

如需分别调试三个进程，可在三个终端依次运行 `npm run start:dev`、`npm run worker`、`npm run worker:imports`。只启动 API 不会消费索引任务，文档会保持 `queued`。

知识文档导入按“上传 → 异步解析 → `/editor/draft` 预览修改 → 确认 → 索引”执行。源文件和图片默认位于 `data/storage`，正文只保存稳定的 `/assets/{assetId}/content` 地址；图片 OCR/描述只在索引快照中追加，不写回编辑器正文。视觉描述未配置或失败不会阻断预览确认。

生产模式会拒绝 memory/hash/heuristic/rule fallback，并要求 MySQL、Qdrant、Transformers.js BGE、BGE reranker、LLM Function Calling 和 API key 全部配置。

## API 兼容

保留 Python 版本的 snake_case 请求/响应、认证、文档 CRUD、索引任务、`/knowledge/search`、`/ai/write`、feedback、metrics、trace 和开发 seed。DTO 使用 `whitelist + forbidNonWhitelisted`，未知字段返回 `422`；浏览器提交 `query_variants` 会被拒绝。

`POST /ai/write` 支持 JSON 和 SSE。SSE 顺序为：

```text
meta -> tool_start -> tool_result -> delta* -> citations -> done
                                      \-------------------> error
```

客户端断开会触发 `AbortController`，并向 LLM fetch 传播取消信号。

## 前端手动联调

前端 `.env.local` 使用：

```powershell
VITE_RAG_API_BASE_URL=http://127.0.0.1:8001
VITE_ENABLE_MOCK=false
```
