# LiveDoc NestJS Server

LiveDoc Python/FastAPI 后端的独立 TypeScript 等价迁移。原仓库 `../livedoc_server` 保留为行为与评测基线；本仓库默认监听 `8001`，不会修改前端默认后端，也不会占用 Python 的 `8000`。

> 当前验证级别：**结构 + memory adapter + HTTP smoke 已验证**。39 项 Jest/Supertest 测试通过；Python/Nest 双服务 memory/hash/heuristic 差分 smoke 的 21 项契约检查通过；18 篇语料和 60 道评测题资产校验通过。Docker、MySQL/Qdrant 集成、真实 Transformers.js BGE、真实 LLM 和 18/60 全量差分评测尚未在当前机器完成，因此不能视为生产验收，也不能据此写入简历指标。

## 为什么是 NestJS + Node.js

NestJS 是运行在 Node.js 上的后端框架，不是与 Node.js 并列的第二个运行时。本项目的准确表述是：**Node.js 20 + TypeScript + NestJS + Fastify**。NestJS 提供 Module、Guard、DTO、Provider 和依赖注入，Fastify 提供 HTTP adapter，Node.js 提供运行时和 Worker Thread。

## 模块边界

- `Auth`：开发身份、PBKDF2 密码、Bearer session、Guard。
- `Documents`：权限感知的文档 CRUD、版本和索引状态。
- `Indexing`：MySQL 任务队列、事务领取、`SKIP LOCKED`、租约回收、重试与版本激活。
- `Retrieval`：Markdown 分块、Transformers.js embedding、TS Jieba BM25、Dense + Sparse、RRF、BGE rerank、去重、压缩与引用。
- `AiWriter`：受约束 Typed Tool Registry、OpenAI-compatible Function Calling、会话记忆、普通 JSON 与 SSE。
- `Observability`：trace、feedback、检索/生成延迟、采用率和队列深度。

模型加载位于独立 Worker Thread。Qdrant 使用命名向量 `dense` / `sparse`，collection 固定为 `article_chunks_nest_v1`，不复用 Python collection。

## 快速验证（不需要 Docker 或模型）

```powershell
npm install --cache .npm-cache
npm run type-check
npm test
npm run build
npm run validate:evals
npm start
```

默认未放置 `.env` 时会使用 memory/hash/heuristic smoke adapter。访问 `GET http://127.0.0.1:8001/health` 可看到 `production_ready: false` 以及缺失的真实组件。演示账户密码均为 `Demo@123456`：

- `alice@livedoc.local`：`team_alpha`
- `bob@livedoc.local`：`team_alpha`
- `carol@livedoc.local`：`team_beta`

## 本地真实组件路径

1. 复制 `.env.example` 为 `.env`，填写 `LLM_API_KEY` 和 OpenAI-compatible endpoint。
2. 启动独立依赖：`docker compose up -d`。端口为 MySQL `3307`、Qdrant HTTP `6335`、gRPC `6336`。
3. 启动 API：`npm start`（开发时 `npm run start:dev`）。
4. 单独启动索引 worker：`npm run worker`（构建后为 `npm run worker:prod`）。
5. 登录后调用 `POST /dev/seed`，再执行搜索、AI 与差分测试。

生产模式会拒绝 memory/hash/heuristic/rule fallback，并要求 MySQL、Qdrant、Transformers.js BGE、BGE reranker、LLM Function Calling 和 API key 全部配置。

## API 兼容

保留 Python 版本的 snake_case 请求/响应、认证、文档 CRUD、索引任务、`/knowledge/search`、`/ai/write`、feedback、metrics、trace 和开发 seed。DTO 使用 `whitelist + forbidNonWhitelisted`，未知字段返回 `422`；浏览器提交 `query_variants` 会被拒绝。

`POST /ai/write` 支持 JSON 和 SSE。SSE 顺序为：

```text
tool_call -> tool_result -> meta -> delta* -> done
                                      \-> error
```

客户端断开会触发 `AbortController`，并向 LLM fetch 传播取消信号。详细端点与切换门槛见 [API_PARITY.md](docs/API_PARITY.md) 和 [VALIDATION.md](docs/VALIDATION.md)。

## 前端手动联调

只做手动验证，不改默认值：

```powershell
$env:VITE_RAG_API_BASE_URL='http://127.0.0.1:8001'
```

只有 Docker 集成、真实模型、同输入差分和 18/60 评测全部通过后，才允许修改前端默认端口。
