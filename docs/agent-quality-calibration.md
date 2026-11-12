# Agent 业务质量、人工校准与容量验收

## 规则检查与语义判分

`evaluate-agent-business.ts` 分别记录 `rule_status`、`semantic_status` 和最终 `status`。规则检查通过后才调用语义 Judge。Judge 请求失败、返回无效结构、总判定与逐项判定冲突时，规则结果继续保留，语义状态记为 `error`。它们进入报告的有效判分覆盖率与错误数。

语义判分核验正确性、完整性、证据支持和持续约束。四项全部通过时才允许 `passed=true`，通过结果要求空问题列表，失败结果要求具体问题。每题保存完整评分输入、原始 Judge 响应、用量和调用日志，便于复现分歧。

报告的 `quality` 同时汇总规则通过数、有效语义判分数、语义通过率、实际输出的判分覆盖率，并按任务组、实际成功生成模型和代码版本分组。旧报告缺少对应 Trace 时回退到其主模型配置，并保留配置模型字段。受控模式的语义指标保持空值。

## 对已有报告生成盲评材料

在后端目录运行以下命令。它们读取已保存产物，使用本地计算。

```powershell
npm run eval:agent-quality -- --report evals/results/某次运行/report.json --out evals/results/某次运行/quality
```

未配置 npm 别名时可直接执行。

```powershell
node --loader ts-node/esm/transpile-only scripts/agent-quality-report.ts --report evals/results/某次运行/report.json
```

输出文件包括 `quality.json`、`summary.md`、`human-review.json`。盲评文件包含题目、编辑器快照、实际候选、实际证据、约束和确认计划信息，自动评分不写入盲评材料。案例指纹复用已有 RAG 的规范化哈希方法，将案例身份与实际输入、输出和证据绑定。模板另绑定题集与评分规则版本，版本变化时需要新的复核材料。

由实际复核人填写 `human_verdict` 为 `pass` 或 `fail`，同时填写 `reviewer` 和 `notes`。随后运行以下命令。

```powershell
npm run eval:agent-quality -- --report evals/results/某次运行/report.json --out evals/results/某次运行/quality --human-review evals/results/某次运行/quality/human-review.json
```

重复汇总保留已有盲评文件。案例内容变化、重复记录、未知案例或盲评原始材料被修改时拒绝汇总。没有填写的记录维持 `pending`。人工与自动语义判定的一致率，只在双方都有有效判定的案例上计算。人工已复核但 Judge 无有效判定的案例单列，规则失败而人工通过的分歧也单列。

## 比较旧报告

```powershell
npm run eval:agent-quality -- --report evals/results/候选/report.json --baseline evals/results/基线/report.json --out evals/results/比较结果
```

比较要求相同题集哈希、评分规则、运行模式和题集类型。输出逐案例状态、两侧分母，以及新增和缺失案例。两次运行的案例集合不同时，`same_case_set=false`，需要结合实际分母阅读结果。

原有业务报告可直接读取。历史报告的语义 Judge 位于规则检查之后，因此已有 `model_grade` 的案例可识别为规则已通过；无法确认的历史状态继续按原记录保留。

## 受控容量与隔离协议

```powershell
npm run eval:agent-business -- --capacity --out evals/results/agent-capacity-v1
```

该模式创建独立 `livedoc_agent_business_controlled_*` 测试库，模型返回固定响应，全局图任务并发设置为 2。协议共创建 3 个用户、4 个任务。

1. A1 与 B1 各占一个运行名额，在可控模型门闩处等待。
2. 提交 A2 与 C1，检查它们处于排队状态。
3. 重复提交 A1，检查返回相同任务；用 B 的身份读取 A1，检查访问被拒绝。
4. 单独释放 B1，让 C1 在腾出的名额中继续执行，同时检查 A2 继续等待 A1。
5. 释放全部门闩，检查四份候选均可通过正式恢复接口读取。

报告记录原始状态采样、阶段、任务创建时间和首次观察到运行时的等待上界。该等待值包含轮询分辨率，缺少运行观察的任务保持空值。协议检查调度、并发上限、同用户串行、其他用户推进、请求幂等和访问隔离。

故障与恢复使用已有专项目标继续验证。

```powershell
npm run eval:agent-business -- --case recovery-pause,recovery-restart --out evals/results/agent-recovery-regression
```

这两个场景在成功步骤完成后暂停，随后继续或跨进程重启，核对已成功工具步骤的复用。容量门闩形成可重复的受控负载，报告只用于该协议的调度和恢复验收。

## 真实运行预算与模型配置

真实运行指定 `--counter` 时，计数文件必须已经存在，避免路径拼写错误导致累计额度重新计数。正常 HTTP 请求仍在实际发送之前预留计数。

使用已配置的 `LLM_MODEL_PROFILES` 与 `AGENT_MODEL_ROUTES` 时，直接运行真实命令即可。子服务会显式继承配置所引用的凭证环境变量，日志保留请求与用量元数据。使用 `--model` 或任一角色模型覆盖参数时，本次评测使用旧式独立模型配置，避免部署路由覆盖命令行指定的模型。受控模式清空部署路由，确保固定响应验收的可重复性。

人工校准需要实际复核记录。真实模型质量与容量结果分别保留验收范围。
