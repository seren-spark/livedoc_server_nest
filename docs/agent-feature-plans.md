# Agent 能力深化功能计划

## 1. 证据核验与局部重规划

为资料型候选建立结论、位置、证据和来源步骤映射。确定性层验证来源、版本和范围，模型判断支持关系。一次纠错循环可修订、补查、失效重跑或澄清，之后复验。临时核验异常保留候选并等待恢复。

新任务采用 Graph v2，按步骤版本与依赖指纹选择有效产物。问题步骤及下游失效，无关产物复用。整篇文稿可重新汇总，选区沿用现有范围校验。v1 继续按保存的拓扑和配置指纹恢复。

验收覆盖正确与错误证据、数字、冲突、缺项、单处编辑、依赖失效、确认、预算、暂停与跨进程恢复。

## 2. 写作 Skills

建立独立 Skill 定义、输入、受限步骤、工具声明和验收条件。提供技术文章、会议纪要、资料对比，支持个人复制编辑。元信息先加载，用户选择后读取完整定义。自动建议由用户选用后生效。

任务保存 Skill 与模板版本快照，映射到现有 DAG 和预算。工具受根授权、模式和角色共同限制。提供选择、参数、预览与管理界面。

验收覆盖三个业务流程、按需加载、版本冲突、隔离、权限、模板兼容与修改删除后的恢复。

## 3. 跨会话偏好

按用户与空间隔离，明确保存或由用户表达生成候选，经确认后生效。保留原文和来源，支持修改、删除、候选拒绝与冲突替换，写入采用 CAS、事务和输入幂等。

独立注入 user_preferences，当前明确要求优先。已确认偏好最多二十条、五百 Token，计入现有四千 Token 会话上下文。任务恢复复用快照。首版偏好持续有效，合并、重要性和过期策略后续再做。

验收覆盖跨会话、当前要求覆盖、来源、并发、重试、删除、隔离、容量与恢复。

## 4. 长文上下文

压缩保留引用、版本、位置、摘要、缺口、冲突和回取标识。read_task_evidence 分页回取本 Worker 或授权成功依赖中的原证据，重新检查权限和版本。编辑阅读证明沿用现有规则。

保存原证据与压缩描述，按步骤选取资料，记录 Token、压缩与回取开销。验收覆盖超窗、数字代码、术语与引用、重复压缩、来源失效、预算、小窗口和恢复。

## 共同交付

扩展既有业务评测并保留原二十题与六项切换基线。每阶段保留原始报告、必要迁移及运行说明。真实请求与评分共享累计预算。部署执行备份、迁移验证、更新与回归。

## 当前接入与运行

四项能力使用新建任务的 Graph v2 策略快照。v1 使用既有构图和指纹，v2 恢复使用保存的策略。`AGENT_GRAPH_VERSION=v1` 控制新建任务版本，已有任务按其保存版本恢复。

Skills 使用 `/ai/skills` 管理，创建任务时保存所选定义和模板快照。偏好使用 `/ai/agent/preferences`，进入新任务时处理用户表达，计划批准的合成内容跳过偏好提取。恢复复用偏好快照，确认与修改输入仍可更新全局偏好候选。

资料压缩复用现有 Markdown 结构压缩，依赖交接的缺口和冲突完整保留。`read_task_evidence` 只取回本 Worker 或成功依赖已采用的证据，回取后继续由原编辑工具取得目标阅读证明。核验使用候选实际采用的证据，局部编辑补充自身已读的当前文档原文。完整观察记录保存在任务产物中。

迁移版本为 `2026111102_writing_preferences`，增加 `writing_skills`、`writing_preference_states` 和 `writing_preference_inputs`。业务环境启用前按备份、迁移、验收和服务更新顺序进行。

当前本地 `.env` 未显式启用图任务，部署默认值仍为关闭。验收和数据库迁移完成后，启用配置如下，并重启服务。

```dotenv
AGENT_GRAPH_ENABLED=true
AGENT_GRAPH_VERSION=v2
```

以下命令供资源恢复后串行验收，每次选择新的报告目录。

```powershell
npm run type-check
npm run build
npm run validate:agent-business -- --enhancements
npm run eval:agent-business -- --enhancements --feature verification --out evals/results/verification-new
npm run eval:agent-business -- --enhancements --feature skills --out evals/results/skills-new
npm run eval:agent-business -- --enhancements --feature memory --out evals/results/preferences-new
npm run eval:agent-business -- --enhancements --feature context --out evals/results/context-new
npm run test:graph:mysql
npm run eval:agent-business -- --switching
```

真实验收继续同一个累计计数文件。

```powershell
npm run eval:agent-business:real -- --enhancements --counter evals/results/agent-switch-20261109/model-counter.json --out evals/results/enhancements-real-new
```

额度、网络、内存和服务异常在报告中保留阻塞状态，人工复核由实际复核人填写。真实成功率、成本和性能改善以实际对照结果为准。
