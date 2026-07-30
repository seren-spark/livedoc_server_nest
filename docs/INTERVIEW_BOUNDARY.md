# Interview and resume boundary

## Safe to say now

> 使用 Node.js 20、TypeScript、NestJS 与 Fastify 搭建独立后端仓库，按 Auth、Documents、Indexing、Retrieval、AiWriter、Observability 拆分模块；复刻 Python/FastAPI API 契约、权限模型、索引队列、混合检索和 SSE 协议，并建立 35 项 Jest/Supertest 结构与 smoke 验证。

可以解释的工程取舍：

- NestJS 仍运行在 Node.js 上；选择它是为了 Module/DI/Guard/DTO 边界，而不是“Node.js + NestJS 两套后端”。
- 不引入 Redis，索引任务依赖 MySQL transaction、lease、retry 和 `SKIP LOCKED`。
- Transformers.js 推理放入 Worker Thread，避免模型计算直接阻塞事件循环。
- 前端保持 thin client，继续使用原 snake_case API 与 `/ai/write`。
- Typed Tool Registry + Function Calling 是受约束编排，不表述为自治 Agent。

## Must remain pending

在真实服务验收前，不要写“完成生产迁移”“性能优于 Python”“真实 BGE/LLM 已跑通”或“前端已切换”。截图中的 200 条样例、86%、55%、90%+、60% 不属于 NestJS 结果，不能继承。

真实 18/60 评测和人工复核完成后，才可以增加经证据支持的指标，并保留运行配置、数据版本、baseline、原始结果和人工复核记录。
