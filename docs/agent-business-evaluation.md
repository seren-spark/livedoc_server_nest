# Agent 业务评测与长会话约束

## 约束记忆

`CONVERSATION_CONSTRAINTS_ENABLED` 在真实运行模式默认开启，隔离测试默认关闭。业务评测显式开启它。旧 `/ai/agent` 与 `/ai/agent/runs` 共用约束提取和上下文构建，外部请求格式沿用现有定义。

每次新的用户输入先通过分类模型提取持续写作目标及约束。输入只有已有有效状态和本次用户输入，更新条目必须附本次输入中的原文。一次性操作及被引用的示例由提取协议排除。模型生成的历史建议继续保留候选标记。

状态按用户、空间、会话和完整文档身份隔离，覆盖 knowledge、article、import、unsaved。每项记录来源输入，整个状态有版本号。更新通过版本比较提交，状态与输入处理记录同事务保存。重试相同输入读取已提交快照，同一标识对应不同内容会返回错误。

会话上下文合计使用 `SHORT_MEMORY_TOKEN_BUDGET`，默认 4000 Token。有效约束最多占 1000 Token、20 个条目，其余容量用于近期完整问答。超限会要求用户精简，提取和存储异常会停止本次生成。约束提取复用现有模型预算与调用追踪，每个新输入使用单次提取请求。

LangGraph 初始任务、计划修改、计划确认和澄清输入保存对应快照。暂停继续和断线重连复用已提交状态。约束保留在角色上下文中，角色工具权限继续由服务端控制。最近问答也按文档身份隔离。

新增表为 `conversation_constraint_states` 与 `conversation_constraint_inputs`，有效期沿用 `MEMORY_TTL_DAYS`，默认 30 天。知识文档彻底删除及导入资料删除会清理对应约束。未保存草稿依靠过期清理。

迁移会根据来源 Agent 任务回填可确认文档归属的旧问答，使文章、导入资料和未保存草稿的历史进入对应作用域。旧检查点缺少约束状态字段时，恢复路由沿用其原有计划／澄清状态。

## 评测命令

在后端目录执行以下命令。

```powershell
npm run validate:agent-business
npm run eval:agent-business
npm run eval:agent-business -- --case memory-window,memory-revise
npm run eval:agent-business -- --baseline evals/results/某次评测/report.json
npm run eval:agent-business:real
```

可用 `--out` 指定新的报告目录，已存在报告的目录会拒绝覆盖。题集为 `evals/agent-business-cases.json`，共 20 个任务，涵盖 6 个问答、4 个编辑、3 个规划、5 个记忆、2 个恢复任务。指定 `--case` 的运行报告只代表选中的任务。

受控模式使用固定模型响应、真实独立 MySQL 数据库和内存检索，执行正式 HTTP 图任务入口及相关恢复、确认、反馈接口。它验证执行与状态行为，生成质量由真实小集和人工复核验证。编辑器实际事务、代码表格保留及撤销还需运行前端的 `document-agent-editor.test.ts`。

真实小集包含 `qa-multiple`、`edit-selection`、`recovery-restart`、`memory-window`、`memory-revise`。模型采用现有角色配置，检索采用 Transformers/BGE 与独立 Qdrant collection。使用合成资料，关闭本轮范围外的后台 Wiki 沉淀和文档记忆提取。

所有运行创建新的 `livedoc_agent_business_controlled_*` 或 `livedoc_agent_business_real_*` 测试库，账号需要创建测试库的权限。可通过 `GRAPH_TEST_DATABASE_URL` 指定测试账号。真实模式还需可用的模型、Qdrant 和本地推理服务。连接参数读取现有配置，报告只记录测试库名及模型和检索配置。

真实运行在实际 LLM HTTP 请求发出前同步计数，约束、规划、执行、自检、重试及评分共用 100 次上限。计数保存在本次输出目录，跨评测子进程重启延续。上限耗尽或外部服务不可用时保留报告，未执行任务标记 `not_run`。

## 判分与报告

`report.json` 记录题集哈希、提交及实现哈希、模型配置、判分版本、任务轨迹、状态快照、原始候选、检查项、失败原因和用量。状态为 `pass`、`fail`、`blocked`、`not_run`。

规则检查覆盖必要事实、来源归属、修改范围、确认边界、约束状态及恢复。真实模式补充独立模型评分，核验完整性与证据支持。`human-review.json` 中的真实任务初始为 `pending`，人工查看题目、证据和产物后填写正确性、完整性、证据支持及备注。模型评分通过仍需保留人工审核状态。

比较报告要求相同题集哈希、运行模式及评分规则。报告保留失败开销，汇总成功率、分组结果、耗时和每个成功任务的 Token 消耗。小样本的耗时分位数按本次样本解释。

## 验证与启用

```powershell
npm run type-check
npm run build
npm test -- --runTestsByPath tests/conversation-constraints.spec.ts tests/dual-memory.spec.ts
npm run test:graph:mysql
```

数据库验证包含跨服务实例读取、重复输入、并发版本冲突，以及处理记录写入失败时的事务回滚。CI 使用 MySQL 8 服务执行题集校验和受控业务评测，真实模型评测通过独立命令运行。

业务服务启用顺序为数据库备份、`npm run db:migrate`、构建及验证、更新服务。新增 schema 版本为 `2026110901_conversation_constraints`。关闭约束开关可停止新输入提取，已保存数据按有效期保留。

## 2026-11-09 验证记录

| 验证 | 结果 |
| --- | --- |
| 后端完整回归 | 33 个文件、359 项通过；15 项独立数据库用例在默认全量中跳过 |
| 新增真实 MySQL 专项 | 4 项通过，包含状态回滚、跨实例、并发及旧问答回填 |
| 前端完整回归 | 10 个文件、56 项通过 |
| 类型检查与前后端构建 | 通过；前端保留既有 Sass 和包体积提示 |
| 受控业务场景 | 20 个场景均有通过记录，首轮及恢复专项复验汇总 |
| 真实模型验收 | 供应商账户返回 `Arrearage`，当前阻塞 |

受控首轮完整执行 20 个任务，19 项通过。暂停脚本最初在等待确认阶段请求暂停，服务按运行状态规则拒绝。修正为确认后在实际执行阶段暂停，两个恢复场景专项复验均通过，且核对成功步骤复用。原始首轮失败记录持续保留。[完整首轮](../evals/results/agent-business-controlled-v7/report.json) · [恢复复验](../evals/results/agent-business-recovery-v8/report.json)

真实首轮 5 个任务均在约束提取请求处收到 HTTP 400。随后最小探针确认 `Arrearage`，追加一个任务验证该错误自动归类为 `blocked`。累计 7 次真实模型请求，实际输出质量和人工复核仍待模型账户恢复。本轮业务库迁移及服务启用待真实验收完成。[真实首轮](../evals/results/agent-business-real-v1/report.json) · [供应商诊断](../evals/results/agent-business-real-v1/provider-diagnostic.json) · [阻塞分类复验](../evals/results/agent-business-real-blocker-v2/report.json)

完整验收汇总保留逐场景证据来源与报告哈希，CI 已完成配置与 YAML 检查，托管执行留待提交后验证。[验收汇总](../evals/results/agent-business-acceptance-20261109/summary.json)


## 执行链切换验收

新增 `evals/agent-switch-cases.json`，包含六个独立场景。局部编辑和计划确认各覆盖思考关闭／开启，联网覆盖关闭／开启。编辑文档含选区外段落、代码块和表格。

```powershell
npm run validate:agent-business -- --switching
npm run eval:agent-business -- --switching
npm run eval:agent-switch:real -- --model deepseek-v4-pro-0813
npm run eval:agent-switch:real -- --case switch-web-off,switch-web-on --model deepseek-v4-pro-0813
```

`--model` 指定本次验收所有角色的默认模型，可分别用 `--classifier-model`、`--plan-model`、`--critic-model` 覆盖。支持 `--counter` 指向已有计数文件，复验及诊断必须延续同一文件。报告同时记录运行前累计次数、本轮新增次数和运行后累计次数。正式模型配置仍由后端 `.env` 管理。

真实验收在 HTTP 请求边界统计普通模型请求和原生联网搜索请求，覆盖模型重试及评分。`model-http.jsonl` 记录模型、开关参数、实际返回的思考信号、工具名称、用量及供应商错误码。思考正文与密钥不写入这些日志。

开启思考的局部编辑场景先通过正式个人配置验证接口，检查计算工具调用、工具结果续接和思考关闭能力。计划场景在确认前检查任务持续等待、尚未交付候选且未执行编辑工具，随后通过正式确认接口执行。联网关闭时检查搜索工具未暴露，联网开启时要求真实搜索请求成功并交付有效网页引用。

将已交付的真实候选送入编辑器事务测试，核对采纳前正文、采纳后选区外内容，以及撤销后的完整 JSON。

```powershell
# 多份报告使用 Windows 路径分隔符 ; 连接。
$env:AGENT_ACCEPTANCE_REPORTS = 'E:\LiveDoc\livedoc_server_nest\evals\results\某次评测\report.json'
npm test -- --pool=forks --maxWorkers=1 src/lib/document-agent-editor.test.ts
```

上面的编辑器命令在前端 `livedoc` 目录执行。受控报告也可用于检查回放流程，其结果单独记录。


备用模型的采样参数可通过现有 `LLM_TOOL_CALL_EXTRA_BODY` 设置，例如 Kimi 使用 `{"enable_thinking":false,"temperature":1}`。主模型调用保留显式温度配置，未设置时沿用 0.2。Qwen `qwen3.8-2.4t-a95b` 的当前接口只接受开启思考，承担思考开关场景前须选择可验证关闭思考的模型。

真实调用暴露了约束提取省略空 `remove` 数组的情况。现在缺省数组视为无该类操作，其余字段及来源校验继续执行。补充了临时计划要求的提取说明，以及计划 ID 和依赖 ID 必须为字符串的生成协议。思考配置验证的供应商 HTTP 拒绝会显示状态码。


## 2026-11-10 切换验收记录

| 验证 | 结果 |
| --- | --- |
| 六场景受控验收 | 单次完整运行 6/6 通过 |
| 后端相关回归 | 5 个文件、60 项通过 |
| 前端全量回归 | 10 个文件、58 项通过，含两份真实候选的编辑器回放 |
| 类型检查与前后端构建 | 通过，前端保留既有构建提示 |
| 真实验收 | 部分调用成功，账户随后再次返回 `Arrearage`，修复后的完整真实验收待完成 |

真实请求验证了普通编辑工具调用、开启思考的计算工具调用及工具结果续接，并生成两份可在编辑器采纳和撤销的局部修改候选。首轮评分缺少补丁语境、约束提取省略空数组，以及计划 ID 类型不符合协议的问题已分别处理。历史失败报告原样保留。

受控验收进一步发现，图任务的自检阶段调用了仅接受终态任务的旧链状态更新，导致开启深度思考后发生状态冲突。图任务现在保留图运行器管理的状态，自检结果仍由图检查点与交付流程持久化。新增回归同时核验旧链自检状态及图任务自检状态。

本地默认模型选择 `deepseek-v4-pro-0813`。Qwen 备用型号在当前接口只支持开启思考；Kimi 的最小结构化探针在温度 1 下成功。它们的完整业务能力仍须按实际配置验证。联网搜索的备用模型兼容性与真实引用验收仍待执行。

累计真实请求为 46/100 次，包含此前业务验收的 7 次，本轮新增 39 次。最新探针仍返回 HTTP 400、错误码 `Arrearage`。真实六场景的修复后复验及人工复核均保留待办状态。

```powershell
npm run eval:agent-switch:real -- --model deepseek-v4-pro-0813 --counter evals/results/agent-switch-20261109/model-counter.json --out evals/results/agent-switch-real-next
```

运行上面的命令会延续已有计数。需要账户当前可用，并选择尚未写入报告的输出目录。

[受控完整报告](../evals/results/agent-switch-controlled-v5/report.json) · [真实首轮](../evals/results/agent-switch-real-restored-v1/report.json) · [真实复验](../evals/results/agent-switch-real-restored-v2/report.json) · [切换验收汇总](../evals/results/agent-switch-20261109/acceptance-summary.json)
