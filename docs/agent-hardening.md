# Agent 质量与运行治理

## 交付范围

本轮优先落地证据覆盖、模型治理、业务评分校准，同时补充运行指标、受控容量验证和同实例片段向量复用。真实任务与人工校准按各自实际结果记录。

- [证据覆盖选择](./evidence-coverage.md)
- [模型路由与故障隔离](./model-governance.md)
- [业务质量与人工校准](./agent-quality-calibration.md)
- [原业务验收和累计调用预算](./agent-business-evaluation.md)

## Agent 运行指标

登录后请求 `GET /ai/agent/metrics?window=24h`。支持 `24h`、`7d`、`30d`，按当前用户和空间隔离，最多汇总最新 500 个任务。超出时返回 `truncated=true`。

指标包括终态任务的交付成功率、用户已处理候选的采纳率、模型请求及重试次数、Token、工具失败、错误码和模型分组。执行成功与用户采纳分别计算，尚无观察值的比率及耗时返回 `null`。失败请求消耗计入 Token 和调用总量。

错误码统计按失败 Span 计数，同一任务可以在模型层和节点层分别记录错误。模型实际返回的 Token 与缺少用量时的预算估算分别展示。

`p50_active_ms` 与 `p95_active_ms` 表示任务有效执行耗时。图任务使用已持久化的 `active_ms`，旧链任务使用记录的 `duration_ms`，缺少记录时保留 `null`。人工等待时间不计入执行耗时。排队耗时由容量验收单独记录。指标响应只返回汇总值。

Token 汇总区分服务商已报告值、未知用量尝试与预算中的估算扣费量。各模型没有已知用量时返回 `null`，未知用量不视为零开销。

## 片段向量复用

Embedding 服务按完整输入内容、模型、维度和推理精度计算指纹。相同片段的已完成及进行中的向量计算可复用，重复输入返回独立数组，失败或非法向量结果从缓存移除。

缓存上限为 1024 项，采用进程内 LRU。正文、标题或标题路径改变会改变实际输入，按新输入重新计算。文档索引仍经过原版本、权限、租约和发布检查。

回归通过模拟推理 Worker 检查三个片段中仅修改一个时只重新计算一个片段，并检查并发复用、失败重试、模型指纹和容量淘汰。该结果描述计算复用行为，真实耗时改善需要在实际文档及模型环境中测量。服务重启后缓存重新建立。

## 运行入口

```powershell
npm run type-check
npm run build
npm run eval:agent-business -- --out evals/results/business-new
npm run eval:agent-business -- --switching --out evals/results/switching-new
npm run eval:agent-capacity -- --out evals/results/capacity-new
npm run eval:agent-quality -- --report evals/results/business-new/report.json
```

受控验收创建独立 MySQL 数据库。真实模型请求统一延续既有累计计数，最多 100 次。

```powershell
npm run eval:agent-switch:real -- --counter evals/results/agent-switch-20261109/model-counter.json --out evals/results/switching-real-new
```

人工盲评模板需要实际复核人填写，校准入口检查题目内容和版本绑定。真实模型和人工校准完成前，报告保留相应待办状态。

## 后续阶段

用户级跨会话偏好与可复用 Skill 生命周期安排在后续阶段，继续基于当前文档记忆、会话约束和模板能力扩展。


## 2026-11-10 验证记录

- 后端全量回归 416 项通过，默认跳过的 15 项 MySQL 专项单独全部通过，追加回归 28 项通过。按文件及完整测试名采用最新结果去重，共 432 项通过。
- 前端全量 58 项通过，包含两份历史真实候选的采纳与撤销回放。前后端类型检查及生产构建通过。
- 20 个受控业务任务单次完整运行全部通过，六个切换任务全部通过。
- 容量协议单实例四任务、三用户、并发上限二的全部检查通过，保留原始状态采样和排队等待观察。
- 独立证据选择开关、固定检索协议与对照因素检查通过。真实检索及性能收益仍待实际环境测量。
- 最新真实模型复验仍返回 `Arrearage`，累计真实请求 49/100。人工校准模板已生成，待实际复核人填写。

数据库专项最初因跨场景复用账号触发一分钟任务限额而出现一项失败。现在每个场景在专用测试库内隔离任务记录，完整复验 15 项通过。容量脚本的首次门闩也已修正为每个任务消息流只挂起一次。初次失败报告持续保留。

[验收汇总](../evals/results/agent-hardening-acceptance-20261110/summary.json) · [业务报告](../evals/results/agent-hardening-business-v1/report.json) · [切换报告](../evals/results/agent-hardening-switching-v1/report.json) · [容量报告](../evals/results/agent-hardening-capacity-v2/report.json) · [人工盲评样本](../evals/results/agent-hardening-quality-sample-v2/human-review.json)
