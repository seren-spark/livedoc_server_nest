# 固定评测原文：长文版

本目录是18篇合成原文的可读来源，每篇约1100—1300字，包含背景、具体规则、过程说明和验收边界。它们不是用户真实笔记，不表达真实组织的安排或预算。

`retrieval-v2-longform` 保留原60个问题的主题与核心事实，使用新的 `_v2` 文档ID，避免覆盖旧短文实验。JSONL 语料中的 `content` 是这些 Markdown 的完整文本；执行 `npm run eval:prepare-retrieval -- --write` 会同步原文、按真实生产 tokenizer 分块并更新逐题 qrels。修改后先检查证据，再更新冻结清单。

当前分块预算为420 tokens、重叠64 tokens，18篇原文共109个 Chunk。具体ID、标题路径、偏移和真实token数见 `../rag_chunks.json`。44道可回答题标注相关片段与必要证据，16道无依据／越权题无相关片段，不能计作召回满分。

| 范围 | 原文 |
| --- | --- |
| 公开 | [权限过滤](eval_public_rag_security_v2.md)、[索引生命周期](eval_public_index_lifecycle_v2.md)、[可观测性](eval_public_observability_v2.md)、[评测协议](eval_public_evaluation_v2.md) |
| 公开 | [延迟事件](eval_public_incident_714_v2.md)、[API错误码](eval_public_api_codes_v2.md)、[发布门禁](eval_public_release_policy_v2.md)、[引用规范](eval_public_citation_style_v2.md) |
| Alpha | [检索架构](eval_team_alpha_architecture_v2.md)、[索引Worker](eval_team_alpha_worker_v2.md)、[回答约束](eval_team_alpha_prompt_v2.md) |
| Beta | [发布检查](eval_team_beta_release_v2.md)、[容量预算](eval_team_beta_secret_v2.md) |
| Alice私人 | [写作偏好](eval_private_alice_style_v2.md)、[项目记录](eval_private_alice_project_v2.md) |
| Bob私人 | [Canvas实验](eval_private_bob_canvas_v2.md)、[分块草稿](eval_private_bob_token_v2.md) |
| Carol私人 | [用户调研](eval_private_carol_research_v2.md) |

相关性整理基于原文，而非某次搜索结果。每个证据组中的摘录都需要被找到；同一组可以跨同一原文的多个片段。实际原文中的多处完整支持都应纳入相关片段，不能为了提高分数只标注一次返回恰好命中的结果。
