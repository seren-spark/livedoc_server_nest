# 多资料证据补位

## 选择过程

正式知识检索与当前文档检索在原有召回、授权、版本检查、重排和去重之后，选择最终待压缩片段。原问题包含明确并列连接词时，将其拆为至多八个词项集合。已有查询改写继续参与原有召回，不把同义改写当作独立任务。

选择器保持第一条相关证据，仅检查既有排序前二十个候选。原文词项按候选中的区分度加权，达到子目标词项权重的 75% 时，作为该子目标已出现的选择线索。标题、文档数量及其他检索元数据不作为命中依据。

若当前 Top-K 缺少某个子目标，按原相关性顺序寻找支持该目标的候选，尝试替换靠后的冗余结果。替换须保留第一条证据，以及其他已出现子目标的覆盖。候选无法满足这些条件时，保留原结果。选择完成后恢复原排名顺序，再使用既有引用构建和 Token 压缩逻辑。

以下情况沿用原排名。

- 单目标问题、没有可辨认的并列子目标、超过八个子目标。
- Top-K 小于二，或达到二十。
- 候选数量不多于 Top-K。
- 显式设置 `evidence_selection=false` 的请求。
- Wiki 页面发现，继续按页面去重并使用原始来源校验。

## 回归和实验

`tests/evidence-selection.spec.ts` 包含固定候选对照，以及正式检索入口的授权、版本、引用 ID、压缩预算、Wiki、当前文档和关闭重排回归。使用三个固定候选时，原 Top-2 为两段负责人描述，补位结果保留最高相关的负责人证据并加入回滚窗口证据。该对照使用同一候选与同一排名，只验证选择机制。

```powershell
npm test -- --runTestsByPath tests/evidence-selection.spec.ts tests/structure-retrieval.spec.ts
```

正式 API 的 `include_retrieval_debug` 返回真实重排前候选、最终待压缩排名和 `selection_strategy`。`rerank` 与 `evidence_selection` 分开控制，生产请求默认启用补位。真实题集复验使用新的输出目录，保留语料、标注、模型、源码及配置版本。

固定检索评测默认显式关闭补位，保持纯重排对照。增加 `--evidence-selection` 可单独开启补位实验。检索协议记录 `rank-v1` 或 `facet-v1`，对照报告同时记录变化因素。旧报告未记录该字段时标记为未记录因素，不能归因到单一算法。端到端回答保持生产默认补位，其实际入模证据策略独立记录。

```powershell
npm run eval:retrieval:fixed -- --mode hybrid --run-dir evals/results/rank-baseline-new
npm run eval:retrieval:fixed -- --mode hybrid --evidence-selection --run-dir evals/results/facet-candidate-new
```

## 边界

词项覆盖是有界的启发式选择线索。它不能判断事实成立、矛盾消解或语义证据充分性，也可能漏掉隐含子目标与同义表达。原文仍按原权限和版本规则处理。最终压缩受原 Token 预算约束，预算不足时仍可能丢失部分线索，因此完整性需要在实际入模证据及最终回答上继续评测。

本改动没有增加模型调用。固定候选与受控回归的结果不代表真实题集召回率、答案准确率或线上收益。
