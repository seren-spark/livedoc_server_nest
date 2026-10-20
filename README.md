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
- 分块与压缩规则、原文定位字段及已有文档重新索引说明见 [Markdown 结构分块](docs/MARKDOWN_CHUNKING.md)。
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

## 文章创作与发布

`/editor/draft` 为文章模式，`?articleId=...` 继续编辑已有草稿；知识库模式仍使用 `?mode=knowledge`。
`/creator/articles` 管理草稿、已发布和已撤回文章，`/synthesis` 展示公开文章，`/post/:id` 支持匿名图文阅读。

草稿单独保存在 `article_drafts`，保存不修改线上正文。发布将公开快照写入 `knowledge_documents`，并在同一 MySQL 事务中创建索引任务。
撤回关闭公开详情、图片和公共检索，保留草稿与原链接。文章快照必须通过 `/articles/:id/publish` 更新；通用文档写入接口拒绝修改它。

升级后执行 `npm run db:migrate`。正常开发使用 `npm run dev` 同时启动 API 和索引 worker，仅启动 API 时文章可以阅读，检索任务会保持排队。
真实验收执行 `npm run validate:articles:real`，覆盖持久化、图文发布、真实索引检索、更新、撤回和再次发布。
脚本只领取本次文章的索引任务，结束后清理本次临时文章及图片，报告保存到 `data/validation/articles-latest.json`。

## 文章评论、点赞与收藏

文章详情支持公开阅读评论，登录后发表评论、删除自己的评论、点赞及取消点赞、收藏及取消收藏。
评论和回复为纯文本，最多 1000 字。评论按时间倒序分页，每条评论的回复可展开并按时间正序分页；总数包含回复。删除原评论会清空正文并保留已有回复，删除自己的回复不影响其他人。`/creator/favorites` 展示当前账号的收藏，创作者中心和文章互动区都提供入口。
`article_comments` 与 `article_reactions` 保存真实数据，点赞和收藏使用用户与文章的唯一键防止重复计数。首页展示真实互动数量。
撤回文章时隐藏评论和收藏入口，重新发布恢复原记录；永久删除旧版文档时清理相关互动。

升级执行 `npm run db:migrate`。真实验收使用 `npm run validate:interactions:real`，报告位于 `data/validation/article-interactions-latest.json`，默认清理本次临时文章。

## 前端手动联调配置

前端 `.env.local` 使用：

```powershell
VITE_RAG_API_BASE_URL=http://127.0.0.1:8001
VITE_ENABLE_MOCK=false
```

## 固定语料与重排评测

已将 LearnHub 的冻结题集、实际证据核验、同题配对实验思路接入 NestJS 评测链路。使用 `npm run eval:protocol` 跑 5 题快速集，`npm run eval:rerank` 对固定候选调用真实 BGE 重排，`npm run eval:judge` 可进一步核验答案是否超出资料；原有 `npm run validate:real` 的 60 题集继续可用。题集标注、初始化、续跑、对比和结果说明见 [RAG 评测指南](docs/rag-evaluation.md)。

官方框架评测：`npm run eval:setup` 安装独立的 Python 3.12 评测环境，再执行 `npm run eval:frameworks -- --report <真实回答报告路径>`。EvalScope 调度 MTEB 的 Embedding／BGE 重排和 RAGAS 的五项生成质量指标，保存原始结果、输入哈希与模型调用记录。生产服务无需 Python 评测依赖。

第一阶段检索回归使用18篇约1100—1300字的长文、109个冻结 Chunk 和60题标注。`npm run eval:prepare-retrieval` 核对原文与分块，`npm run eval:retrieval:fixed` 计算 Chunk Recall@3、MRR@3、NDCG@3、重排前候选池 Recall@20 并保留失败样例；`--mode` 与 `--no-rerank` 支持策略对比。原文目录见 [长文语料](evals/corpus/README.md)。

第二阶段使用`npm run eval:answers`运行60题实际问答，`eval:judge -- --references evals/rag_references.json`评分语义事实覆盖、Correctness和拒答行为，`eval:frameworks -- --stage ragas --metrics core`通过官方EvalScope/RAGAS评分Faithfulness和FactualCorrectness。`eval:quality`合并本轮实际检索证据、失败归因和待人工填写的盲评表；空表明确保留人工校准pending。基础专项回归已覆盖权限、无依据拒答与索引版本污染，完整CI门禁仍需业务数据和人工校准后确定。完整命令见[RAG评测指南](docs/rag-evaluation.md)。
