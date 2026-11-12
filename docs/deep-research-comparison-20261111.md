# Deep Research 全文件静态审查与 LiveDoc 对照

日期：2026-11-11。

审查对象：`D:\agent 开发\代码\project-Deep_Research`，对照 `E:\LiveDoc\livedoc_server_nest` 当前源码。没有启动应用、执行项目代码、发出模型请求或修改业务实现。

## 1. 覆盖范围与结论边界

Deep Research 共 43 个文件：37 个 Python 文件、3 个配置/依赖文件、1 个 Notebook、2 个 Markdown 样例。37 个 Python 文件及全部提示词已阅读全文；Notebook 读取全部 9 个单元源码、保存的文本运行日志及最终报告。Rich 渲染文本是同一报告的展示形式，图像是工作流可视化，不是额外业务实现。两份结果样例阅读全文。该目录没有独立 README 或开发文档目录。

LiveDoc 按对应能力追踪当前的图编排、Runtime、主管、工具、交接、审核、证据核验、写作 Skills、模型路由、上下文与能力文档；没有声称逐文件审查整个 LiveDoc 仓库。

这里的“优于”分为三种：

- **实现差异**：源码能直接证实某条路径具有更大能力或更细分工。
- **设计参考**：提示词、数据结构或流程更适合研究报告，但没有效果对照证明更好。
- **不成立**：LiveDoc 已有对应实现，或 Deep Research 只有声明/未接入实现，不能算优势。

本次没有同题、同模型和同预算运行两个项目。不能据此宣称 Deep Research 的准确率、速度、成本或稳定性更好。Notebook 保存的是历史运行结果，不保证与当前磁盘代码完全一致。

## 2. 逐文件记录（43/43）

以下除顶层文件外，路径相对 `deep_research/`。

| 序号 | 文件 | 实际逻辑与审查结论 |
| --- | --- | --- |
| 1 | `config.yml` | 配置 OpenAI-compatible 模型、Tavily 和多种角色；角色分得较细，但各角色的 `max_tokens` 没有被 `get_chat_model` 直接采用。 |
| 2 | `env.example` | LangSmith 追踪环境变量示例；不能由此认定已经形成质量评测或成本看板。 |
| 3 | `requirements.txt` | 框架、模型、搜索、Notebook 依赖；存在未在当前业务路径使用的适配包，不代表相应能力已经实现。 |
| 4 | `run.ipynb` | 9 个代码单元：版本、dotenv、内存 Checkpointer/可视化、研究调用、展示、保存、原文打印与两个空单元。保存日志展示二次检索、四次修稿评分和三次红队反馈；运行不是本次执行。 |
| 5 | `results/output_report_sample_1.md` | GPU 调研报告，含规格对照、来源及大量缺口说明；可作交付风格参考，不能用报告文字证明参数已被程序逐项核验。 |
| 6 | `results/output_report_sample_2.md` | Memory 调研报告，含路线、权衡和建议；存在正文引用编号与参考列表不匹配、重复 URL。内容谈到 Memory 不表示项目实现了这些记忆系统。 |
| 7 | `__init__.py` | 仅占位。 |
| 8 | `agent_builder.py` | 主图：简报→初稿→主管子图→最终报告；最终报告由独立 writer 再生成，没有最终质量复核或正式持久化 Checkpointer。 |
| 9 | `llm.py` | 按角色读配置、缓存配置、构造模型。模型后端实际仅处理 openai 分支；角色参数的支持范围小于配置表面表达。 |
| 10 | `logging.py` | 集中日志、stdout/stderr 分级、可选文件输出；不构成比 LiveDoc 的调用 Trace/预算审计更强的证据。 |
| 11 | `utils.py` | 日期、路径和 YAML 读取。`%-d` 有平台兼容性风险，不作为迁移建议。 |
| 12 | `agents/__init__.py` | 导出简报、初稿及主管图。 |
| 13 | `agents/draft_agent.py` | `write_research_brief` 生成研究简报；`write_draft_report` 根据简报生成初稿，再交主管。注释称包含澄清，实际没有澄清节点。初稿生成前没有执行检索。 |
| 14 | `agents/research_agent.py` | 模型→工具→模型循环，无工具调用才压缩。可多次搜索；逐个执行同轮工具调用；输出文本研究笔记和 raw_notes。搜索次数字段未被实际维护。 |
| 15 | `agents/supervisor.py` | 主管动态调用 think/research/refine/complete；多个研究子图 gather，修稿后评分并进入红队。主循环限制 15 次主管调用，声明的并发 3 没有在 gather 处硬校验。 |
| 16 | `agents/evaluator_agent.py` | 单独 evaluator 模型输出全面性、准确性、一致性分数与理由。输入仅简报和草稿，没有原始证据，不能当作事实核验。 |
| 17 | `agents/red_team_agent.py` | 单独 red_team 模型返回最多三条建议，最多产生三次批评；`PASS` 子串和短文本可被当成通过，未关闭已解决 issue。 |
| 18 | `prompts/__init__.py` | 统一导出 14 个提示词，包括当前未接入的澄清提示。 |
| 19 | `prompts/clarify.py` | 提问/不提问 JSON 协议，只在导出中出现，没有接入主图执行。 |
| 20 | `prompts/research_brief.py` | 明确研究维度、用户偏好、未给定条件、来源优先级和语言；对研究任务理解有参考价值，但扩展维度可能扩大范围。 |
| 21 | `prompts/draft_report.py` | 研究报告结构、比较/清单/概述写法、引用规则；初稿缺实际搜索输入，提示不等于已取得依据。 |
| 22 | `prompts/research_agent.py` | 广搜→评估→精准搜索；两次重复结果停搜、简单 2–3 次/复杂最多 5 次。都是提示约束；其中 `{date}` 在研究节点没有 format。 |
| 23 | `prompts/research_denoise.py` | 从草稿不足生成研究问题、研究后修稿、独立主题分配。并发/预算多为提示；有 CompleteResearch/ResearchComplete 命名混用及非英语额外研究规则。 |
| 24 | `prompts/refine_report.py` | 以简报、已有草稿和发现改写全文；不属于按段落的局部补丁修复。 |
| 25 | `prompts/final_report.py` | 最终综合，强调原因/影响、对照表、实用性、来源。全文再次生成，并不保留已审查草稿的逐字正确性。 |
| 26 | `prompts/compress_system.py` | 组织研究材料、去重、保留来源，提示排除 think；同时要求近乎逐字保留全部相关内容，未保证实际压缩比例。 |
| 27 | `prompts/compress_human.py` | 再次强调细节和来源完整性。没有容量预算和完整性程序校验。 |
| 28 | `prompts/summarize_webpage.py` | 网页摘要+最多五个关键摘录，强调统计、日期、步骤和内容类型；摘要完整性及摘录是否原文没有程序验证。 |
| 29 | `prompts/draft_evaluator.py` | 全面性/不偏题/一致性评审。准确性维度主要检查是否符合简报，区别于事实蕴含判断。 |
| 30 | `prompts/red_team.py` | 提出遗漏、偏题和矛盾等最多三项可执行意见；与 LiveDoc Critic 有明显职能重叠。 |
| 31 | `prompts/critical_address.py` | 将缺信息→研究、逻辑问题→分析、草稿问题→修稿的意见交给主管。是反馈提示，不是动作级硬约束。 |
| 32 | `providers/__init__.py` | 描述 Provider 的注册协议。 |
| 33 | `providers/customsearch.py` | 自定义搜索示例桩，search 抛 NotImplementedError；导入 `deep_research.search_factory` 与实际 `deep_research/tools/search_factory.py` 路径不一致。不能算已完成自定义搜索。 |
| 34 | `states/__init__.py` | 统一导出状态和结构化模型。 |
| 35 | `states/critique.py` | author/concern/addressed；执行代码只创建 addressed=false，没有更新为 true 的流程。 |
| 36 | `states/draft.py` | 主图消息、简报、初/终稿、笔记；笔记用追加 reducer，研究问题和初稿是单字符串结构。 |
| 37 | `states/eval_result.py` | 三项整数分数+理由，没有 0–10 数值范围约束。 |
| 38 | `states/quality.py` | 分数、反馈、迭代号；主管保存的是平均分，详细分项主要留在日志。 |
| 39 | `states/research.py` | 研究消息、主题、压缩/原始笔记；Summary 包含 summary/key_excerpts。tool_call_iterations 只是定义。 |
| 40 | `states/supervisor.py` | 主管状态、批评/评分历史、ConductResearch 和 ResearchComplete；支持动态主题委派，但没有依赖 DAG/证据权限校验。 |
| 41 | `tools/__init__.py` | 导出搜索、think、修稿三个工具。 |
| 42 | `tools/search_factory.py` | Provider 协议、注册/覆盖/动态导入、Tavily/client 缓存及 defaults；扩展点清晰，但自定义样例本身不可直接使用。 |
| 43 | `tools/tool.py` | 搜索→URL 去重→有 raw_content 则逐页摘要→格式化；think 只回显；修稿工具调用 writer。搜索/网页摘要为串行，摘要异常截取前 1000 字。 |

## 3. 完整数据流及关键限制

1. `write_research_brief` 接收消息文本，生成单个 research_brief 字符串。
2. `write_draft_report` 用简报生成未经本次检索验证的初稿；简报及初稿进入 supervisor_messages。
3. Supervisor 绑定四个工具，由模型决定思考、发起研究、修稿或结束。
4. ConductResearch 每次只给子 Agent 一个独立主题；子 Agent 看不到主管完整对话。主管同轮多个研究通过 gather 执行。
5. 子 Agent 搜索循环：查询→Tavily 结果→按 URL 去重→有网页正文则摘要和摘录→工具返回→模型继续搜索/停止。
6. 子 Agent 结束时，再将整段研究历史整理为 compressed_research；raw_notes 同时保存 AI/工具消息，并非独立持久化的原网页仓库。
7. 主管将研究笔记放入 ToolMessage；refine 工具以简报、旧草稿、已有工具消息再生成草稿。
8. Evaluator 评分，平均低于 6 设置质量修复标记；Red Team 对修订稿提意见并追加到主管上下文。提示中的低于 7 与代码阈值不一致。
9. ResearchComplete、无工具调用或达到主管迭代上限时结束。代码不是“只有质量达标才能结束”。
10. 主图 writer 依据笔记和草稿再生成最终报告。最终报告没有再接受 Evaluator、Red Team 或原始证据逐条核验。

特别问题：`get_notes_from_tool_calls` 收集全部 ToolMessage，不仅 ConductResearch，因此 think 文本和评分反馈也可混入后续 findings。若同轮同时 research 和 refine，refine 使用旧 state 消息，没有包含本轮尚未提交的研究 ToolMessage；若同轮有多个 refine，读取的仍是 state 里的旧草稿。上述问题限制了“研究→立即修稿”的可靠性。

Notebook 保存的历史日志显示：先分派三个主题；子研究在搜索不命中时调整关键词或域名；随后四次修稿的分项为 6/6/8、6/6/8、6/7/8、6/7/8，红队产生三次意见，主管最终因循环上限退出。该样本证明迭代路径曾发生，也证明质量可能停滞；不证明额外轮次具有稳定收益。

## 4. LiveDoc 当前已有能力，不能再当作新增项

| 能力 | 当前证据 | 结论 |
| --- | --- | --- |
| LangGraph.js、状态图与人工中断 | `package.json`；`src/ai/graph/agent-graph.workflow.ts:1` | 已接入，不能建议“开始接入 LangGraph”。 |
| MySQL 检查点、运行产物、事件与恢复 | workflow 的 MySqlCheckpointSaver；`docs/agent-graph.md` | 实现比 Notebook 的 InMemorySaver 更完整；未在本次验证运行状态。 |
| 并行 Worker、主管补查、结构化交接 | `agent-supervisor.service.ts:283`；`agent-runtime.service.ts:449`；`agent-handoff.ts` | 已有，不能把多 Agent 或缺口交接本身算 Deep Research 优势。 |
| Critic 与候选修订 | `document-agent.service.ts:847` | 已检查目标、证据、结构、一致性及 Skill 验收条件。 |
| 证据语义核验与纠错后复验 | `evidence-verification.service.ts:176`；workflow `:770` | Graph v2 已有 repair/research/rerun/clarify，一次纠错后复验；不是只有引用 ID 校验。 |
| 技术文章、会议纪要、资料对比 Skill | `writing-skills.service.ts:50` | 已有“读取→研究→写作”，不能把串联这些阶段包装成全新能力。 |
| 上下文压缩、原证据回取 | `agent-runtime.service.ts:109`、`:383`；`read_task_evidence` | 已有。Deep Research 不是在长上下文架构上全面领先。 |
| 角色模型配置、Profile、故障回退与熔断 | `model-routing.ts`；`docs/model-governance.md` | 已有；可讨论角色粒度，不能建议从零做模型路由。 |
| 多目标检索证据补位及 Wiki 缺项补检 | `docs/evidence-coverage.md`；`document-agent-tools.service.ts:909` 起 | 已有词项启发式和 Wiki 覆盖机制；下文的“需求覆盖”指最终研究交付，不是重做召回。 |

## 5. 真正可迁移的差异与优化清单

### P1-A：为复杂研究提供有界的多次检索

**差异明确。** Deep Research 的 `research_agent.py:39`、`:111` 允许子 Agent 根据结果继续搜索；提示词 `research_agent.py:16` 明确从广搜转到精准搜索。保存日志也展示首次查询无结果后换关键词/站点。

LiveDoc 的 `agent-runtime.service.ts:793` 在受主管管理的 Researcher 成功执行一次名称含 search 的工具后移除所有 search 工具；`:486` 单步骤最多四轮。该限制仅适用于这条受管路径，不能泛化成所有 LiveDoc Agent 都只能搜索一次。Wiki 的一次工具调用还可能内部补查原文，也不能把工具调用次数等同于底层检索次数。

**建议：**普通任务沿用一次搜索；明确复杂研究时允许本步骤 2–3 次有目标的检索。以共享预算、剩余必要步骤和交付预留约束次数，记录待解决问题及每次新增证据；重复结果或无信息增量则停止。结合需求在同一授权范围内先查知识库、再查询被允许的外部来源。不能直接删除限制或只提高全局轮数。

**预期收益需验证：**减少第一次召回不佳就提交缺口的情况；指标为缺口补齐率、正确答案率、重复检索率、Token 和延迟。

### P1-B：让草稿的研究不足反馈到后续研究

**存在灵活性优势，可靠性不占优。** Deep Research 的主管输入一直包含初稿，后续可反复 research/refine；`supervisor.py:267` 修稿评分后进入 red_team，再回到主管。

LiveDoc `agent-supervisor.service.ts:300` 左右的调度 payload 以计划和 Worker handoff 为主，不接收当前完整最终候选；`document-agent.service.ts:847` 的通用 Critic 修订不调用工具、不得引入新事实。Graph v2 已有从最终候选证据问题回到 research/rerun 的流程，但 `workflow:798` 限制一次纠错，补查还与前面使用同一补查次数。因此差距是**迭代自由度和写作质量反馈的联动**，不是“没有反思/补查/重规划”。

**建议：**对研究型文章，将 Critic 的重大遗漏转为结构化 research gap，并交给现有恢复动作处理；区分改写即可解决的问题与必须补证据的问题。首版维持一个受预算约束的研究改稿循环；确有评测收益再增加轮次。持久化候选版本、问题状态及新增来源，避免重复处理同一意见。

**验证：**构造“每句都正确但漏了用户要求的一整个维度”和“现有证据不能支撑比较结论”的题目，核对是否正确补查或明确保留缺口，而非只润色。

### P1-C：联网长文改为按问题提取摘要和可定位摘录

**处理链有明确差异。** Deep Research `tools/tool.py:197` 先对本次搜索结果按 URL 去重，`:217` 对 raw_content 逐页生成 summary/key_excerpts，提示词保留日期、数值、列表和步骤；每页最多输入 250000 字符，不是 250000 token。

LiveDoc 已有搜索和正文提取：`agent-settings.service.ts:142` 区分 search/extract，但输出每页内容直接 `slice(0,5000)`；原生 `llm.service.ts:62` 路径返回搜索汇总及来源，并不保证每个来源都是整页原文。不能说 LiveDoc“不能读取网页”，也不能忽略 MCP 等其他工具路径。

**建议：**在已支持的正文提取路径上保存原文，再按研究子问题选择相关段落并返回摘要、原文摘录、来源定位和未覆盖范围。摘要用于导航，核验继续使用原文；优先补取关键来源，避免每个结果都付出摘要模型费用。数字、表格、代码和结论条件优先保留。已有授权和公网访问校验继续复用。

**验证：**把答案放在网页 5000 字之后、摘要中省略条件、两个页面数值相近但主体不同，检查后文证据召回及摘录一致性。

### P2-A：研究简报与逐项覆盖报告

**设计参考，不是全新能力。** Deep Research `prompts/research_brief.py:15` 明确区分用户偏好、研究范围、未给定条件和来源优先级；Evaluator 强调全面性。LiveDoc 的计划已有 goal/outline/constraints，Critic 也收到用户要求、计划、模板和 Skill acceptance，但返回结构只有 passed/issues；当前证据核验报告围绕候选里已经写出的段落构造 claims。

这意味着现有机制能发现遗漏，却缺少显式的“用户要求→研究证据→文章位置→是否覆盖”交付结构；不是断言它目前完全不能识别遗漏。

**建议：**扩展现有计划/Skill 的研究任务说明：必答问题、可选补充、开放条件、来源要求。审核输出每项是否覆盖、正文位置、依据和未满足原因。公开事实、资料中未找到的信息、基于材料提出的建议应区分表达。不要通过额外简报偷偷增加用户没有要求的调研范围。

**验证：**多个必答问题、只问子集、缺失条件、不允许外网及用户指定来源等场景；没有证据时标缺口，而不是为通过覆盖检查补造内容。

### P2-B：研究笔记采用短交接加按需明细

**研究信息容量更宽，但不是权限或结构优势。** Deep Research 子 Agent 的 compressed_research 是可包含长篇事实和来源的字符串。LiveDoc `agent-handoff.ts:16` 最多六条 findings（每条 500 字符）、六条 missing（每条 300）、三条 conflicts。主管主要看这个交接，因此面对复杂研究可能过于概括。

但 LiveDoc 下游还接收 `step_results`、`dependency_evidence` 及可回取来源，不能说“第七条事实必然被全系统丢弃”。Deep Research 的“逐字保留所有相关材料”也不是有效的容量治理。

**建议：**保留现有交接摘要和证据约束，增设按子问题组织的研究明细产物及目录；主管只读摘要，需要时读取相关明细；最终 Writer 按章节取证。不要无限放大 JSON 数组或把全部原文塞给主管。

**验证：**超过六项独立事实、多比较对象、数字/例外分散在不同来源的长任务；检查最终必要信息的保留率及上下文成本。

### P3-A：细分模型任务与提示词模块

**分工更细，不代表成本更低。** Deep Research 为 researcher_main/summarizer/compressor/writer/evaluator/red_team 单独选择模型；LiveDoc `model-routing.ts:5` 为 main/classifier/plan/critic，压缩使用 plan。两个项目都已有模型路由；Deep Research 当前实际模型后端也只有 openai 分支。

**建议：**只有在 Trace 显示压缩或网页摘要的成本/能力需求与规划不同后，再增加 summarizer/compressor 角色；研究决策与文章生成也可按任务选择独立 Profile。将长提示词从业务分支提取为有版本的模块，方便同题对照。优先沿用当前回退、熔断、预算与能力过滤。

## 6. 不应直接借鉴的实现

1. **先凭模型知识写有引用的完整初稿。** 搜索前没有真实依据，会给后续研究造成锚定；可改为提纲/待证实问题，不应带未经观察的正式引用。
2. **平均分作为事实质量门槛。** Evaluator 不看原证据，分数也没有范围校验；完整性和文风的高分不能抵消事实错误。
3. **持续红队等于持续变好。** addressed 没有闭合，PASS 子串判定宽松，历史意见可重复注入；保存日志也展示停滞。
4. **把提示词约束当作执行上限。** 子 Agent 五次搜索及主管最多并发三项缺少对应硬校验，LiveDoc 的程序校验需要保留。
5. **汇总全部工具消息作为事实。** think 和质量分数不是外部研究证据，不能进入事实材料。
6. **吞掉异常后继续出最终报告。** 主管捕获 Exception 后直接结束，外层仍可能写报告，难以区分研究完成和研究失败。
7. **最终重写后不复核。** 被审过的是中间草稿，新生成的 final_report 仍可能引入新错误。
8. **把结果样例当作质量验收。** 样例有引用错位和重复来源，未提供同题基线、原始证据逐条支持标注或完整测试套件。

## 7. 推荐落地次序

1. 对现有复杂研究路径设计小规模题集，测量一次搜索实际造成的缺口，不修改普通问答默认行为。
2. 联合实现“有界二次检索”和“关键网页按问题提取原文”，先验证证据获取改善。
3. 用现有 Critic/恢复图承接研究型写作的重大缺项，增加目标覆盖报告；不再重复建设证据核验器、Skill 或 Checkpointer。
4. 只有长任务出现交接压缩遗漏时，增加按需研究明细；模型角色进一步拆分及提示词整理随后处理。

每项实验固定题集、模型、资料范围与累计预算；分别记录准确性、需求覆盖、证据支持、未解决缺口、Token 和耗时。收益未被验证前，只称能力扩展或设计优化。
