# 研究型写作

## 使用

在文档助手的写作流程中显式选用“研究型写作”，选择知识库或附加资料，再提交写作要求。支持独立文稿和当前文档建议；正文仍由用户预览采纳。Plan 模式和明确要求先确认计划的任务沿用原确认入口，其他 Agent 请求不额外增加确认。

先生成研究简报，将必答问题关联到章节；Worker 返回短交接及独立研究明细。每个 Researcher 最多搜索三次、最多八轮调用。后续搜索绑定 question_id 和 gap_reason；重复查询、连续两次无新证据或额度不足时停止。首次空结果允许换查询。最终一轮用于提交发现、冲突和缺口。

要求覆盖审查与事实核验分开：事实有依据但遗漏一个问题仍需处理。已有资料漏写时修订，缺资料时定向补查，错误步骤按依赖失效重跑，必要条件不明时澄清。质量问题共用一次纠错循环，主管和核验共用一次补查。修改后重新审查覆盖和事实。资料仍不足可以交付明确说明缺口的部分草稿；技术性核验故障进入可恢复中断，不交付未完成核验的候选。

## 长网页与长文

研究流程的个人 Tavily 路径保存服务返回的正文快照，按问题返回有偏移的相关摘录。原文与 Worker 实际观察内容分别保存，read_task_evidence 可分页回取。搜索摘要、原文及工具输出继续区分，网页摘要仅用于导航。只有已取得原文的来源才标记 source。未使用个人正文能力的原生搜索不会被伪装成已读网页。

研究明细以问题组织，Supervisor 继续读取短交接；Writer 可用 read_research_notes 分页读取成功依赖的明细。明细里的事实和冲突必须引用该步骤实际读取并采用的证据。

长正文事实核验按 Markdown 段落分批，每批通常不超过 2400 字符，保持原文 UTF-16 位置并合并唯一结论标识；批次的模型请求仍共享根预算，所有批次通过后才能交付。代码、表格等原子块不拆开。单个超大块仍受模型上下文与输出上限限制。

目标字数至少 4000 或简报有至少四个正文章节时分章生成；选区修改跳过分章。章节使用相关研究笔记和预算内的证据预览，完整证据仍保留。章节产物按输入及提示词指纹保存，恢复复用已提交章节，全文整合后重新核验。当前文档整合保留每条 edit 的标识、操作和目标，不能扩展范围。

## 接口与存储

- Skill 定义新增可选 workflow=standard/research_writing；复制 Skill 保留 workflow，旧定义缺省 standard。
- 使用原 POST /ai/agent/runs 和 skill_id；capabilities.research_writing_available 表示可用性。
- GET /ai/agent/runs/:id/research?question_id=q1&offset=0&limit=10 返回简报、覆盖报告和研究明细。limit 为 1—20；读取前重新核对当前身份和资料权限、版本。
- SSE 增加 research_brief、research_progress、research_section、research_coverage，复用持久化全局 seq。事件不广播网页全文或全部笔记。
- AgentResult 保持原五种类型，研究报告是任务附属产物。

复用 agent_runs.payload 和 agent_run_artifacts，不新增表。新研究任务保存 agent-v2-research-1 策略和 research-writing-1 提示词版本；普通 v2 保留 agent-v2-policy-1，v1 保持原拓扑。恢复使用保存的策略，未知或被篡改策略拒绝恢复。已经发布的提示词版本需要保留，修改其内容时发布新版本并保留旧版本处理未过期任务。

成功步骤和章节可复用；步骤内部尚未完成的模型／工具调用仍可能重做。账本预算和累计运行时间不重置，原文快照随运行产物按既有保留策略清理。

## 模型与预算

AGENT_MODEL_ROUTES 新增可选职责：researcher、web_summary、research_compressor、writer、coverage。未配置时 researcher/writer 回退 main，web_summary/research_compressor 回退 plan，coverage 回退 critic。复用模型 Profile、能力检查、熔断、回退及隐藏推理生命周期。分类和规划继续使用既有角色。

根预算保持原 AGENT_MAX_MODEL_REQUESTS、AGENT_MAX_TOTAL_TOKENS、AGENT_MAX_TOOL_CALLS、AGENT_TIMEOUT_SECONDS 等配置。研究和章节请求保留最终交付额度，摘要、压缩、审核、失败及重试计入同一账本。追踪记录职责、实际模型、提示词版本和哈希、耗时与用量，不保存隐藏推理或凭证。没有经过真实对照评测，不调整默认模型。

## 验收命令

```powershell
npm run type-check
npm run build
npm run validate:research-writing
npm run eval:research-writing -- --out evals/results/research-controlled-new
npm run eval:agent-business -- --research --research-baseline --out evals/results/research-baseline-new
npm run test:graph:mysql -- --cacheDirectory=.cache/jest
```

Windows 沙箱限制默认临时目录时，Jest 使用工作区 cacheDirectory；前端 Vitest 的 TEMP/TMP 可以指向工作区 .cache/test-tmp。

真实验收和原流程对照使用相同题集、模型与评分规则。只使用新建的独立测试库、独立向量集合和合成 business 用户；知识范围限定为本次创建的 Orion 资料 ID。关闭联网、后台 Wiki 沉淀和文档记忆提取，不读取业务知识库。

```powershell
npm run eval:research-writing:real -- --counter evals/results/agent-switch-20261109/model-counter.json --out evals/results/research-real-new
npm run eval:agent-business:real -- --research --research-baseline --counter evals/results/agent-switch-20261109/model-counter.json --out evals/results/research-baseline-real-new
```

所有真实请求和评分共用原 100 次累计上限，不重置计数。输出保留原始候选、过程、覆盖、事实审核、失败成本、延迟和 Token。模型评分不代替人工复核，未完成场景保持 blocked/not_run。

## 启用与回退

本功能没有新增数据库迁移，但依赖已有 Graph、约束及写作偏好迁移。业务环境先备份，核对既有迁移完成，构建与回归通过、真实验收及人工复核完成后，再设置 AGENT_GRAPH_ENABLED=true、AGENT_GRAPH_VERSION=v2 并重启服务。开发过程中不自动修改业务 .env 或迁移业务库。

回退可关闭新建图任务或停止提供研究写作 Skill，旧运行的策略实现与读取、恢复入口保留。停止或失败任务不暗中续跑，不重置预算。

实际进度和验收结果见 research-writing-implementation.md。
