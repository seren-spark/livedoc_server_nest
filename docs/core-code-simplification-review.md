# 核心代码精简审查

审查与验证于 2026-11-08 执行，2026-11-09 汇总。

## 范围与结论

实施范围为现用 React/Tiptap 前端与 NestJS 后端，以开始实施时的工作区为比较基准，保留原有未提交修改。

对两个项目 `src` 下的 329 个 TypeScript/TSX 文件进行语法结构与重复函数扫描，并按下表核查核心调用链。结构扫描用于定位重复候选，业务判断结合调用方、状态生命周期、异常分支和既有测试。

本轮调整 19 个业务实现文件，新增 234 行、移除 445 行，业务实现净减少 211 行。该统计包含新建的共用流读取文件，测试单独统计。新增 18 个前端回归用例和 1 个后端预算回归用例。

核心问题集中在重复实现、相同数据的重复转换、重复查询和已经失去作用的局部变量。权限、来源版本、读取证明、取消、重试、人工采纳、事务与租约检查按原有职责保留。

## 已精简的文件

前端路径相对 `livedoc`，后端路径相对 `livedoc_server_nest`。

### 前端

| 文件 | 调用方与职责 | 证据与处理 |
| --- | --- | --- |
| `src/api/sse.ts` | 三个流式客户端的共用传输实现 | 集中处理 UTF-8 解码、SSE 分帧、多行数据和 reader 释放。保留两个 Agent 取首个 event 字段、写作接口取最后一个字段的既有差异。 |
| `src/api/document-agent.ts` | 文档助手普通执行入口 | 复用共用读取器，保留严格递增序号、done 完成检查、401 处理及错误文案。 |
| `src/api/document-agent-graph.ts` | 可恢复任务的进度订阅 | 复用共用读取器，保留旧序号过滤、重连游标、提交后恢复候选和后台任务控制。 |
| `src/api/rag.ts` | 写作流、检索、文档与导入 API | 合并写作流的重复读取循环，保留各类事件分发与网络错误处理。 |
| `src/hooks/useKnowledgeDocumentSession.ts` | 编辑页的知识文档加载和保存 | 四处重复的正式文档保存收尾合并为局部函数，共用保存请求内容。分别保留新建、已有文档、导入预览、导入确认、409 幂等识别、单次重试及团队冲突处理。补齐保存回调使用的依赖。 |
| `src/components/Knowledge/DocumentAgentPanel.tsx` | 助手交互、附件轮询与候选保存 | 同一轮询复用附件 ID 列表，保存候选时只转换一次带引用的 Markdown。保留页面切换、登录变化、任务恢复和候选采纳的状态边界。 |
| `src/lib/citation-location.ts` | 助手与问答面板定位原文 | 一次定位复用同一份正文文本和位置映射，多个候选片段共用查询实现。保留公开函数签名、偏移优先、片段回退和匹配顺序。 |

### 后端

| 文件 | 调用方与职责 | 证据与处理 |
| --- | --- | --- |
| `src/ai/agent-execution.ts` | Runtime 与联网工具的预算预留 | 增加共用的 Worker 预算预留入口，统一选择持久化账本或内存记账，沿用已有结算实现。 |
| `src/ai/agent-runtime.service.ts` | Primary、Reader、Researcher 工具循环 | 将重复的输出额度、请求上限与最终交付预留计算为局部值，调用共用预算入口。保留并行预留、失败估算扣账、模型重试和取消处理。 |
| `src/ai/document-agent-tools.service.ts` | Runtime 执行授权工具 | 联网搜索复用同一预算入口，消除两套分支中重复的预算参数。保留工具权限、引用类型与真实读取证明。 |
| `src/ai/document-agent.service.ts` | 普通执行、Graph 共用交付与结果恢复 | 三处重复的引用来源检查合并为私有方法。最终交付复用已选引用和区域覆盖结果，收敛未使用的内部参数及局部变量。各阶段仍执行对应的权限和版本复核。 |
| `src/ai/graph/agent-graph.workflow.ts` | 持久化工作流调用共用交付 | 对齐共用交付函数的内部参数，省去未被消费的对象构造。 |
| `src/ai/agent-audit.service.ts` | Agent 运行与工具审计 | 内存模式的重复请求判断与函数入口判断完全相同，合并为入口处的一次判断。保留数据库唯一键冲突和内存降级处理。 |
| `src/ai/ai-writer.service.ts` | 普通问答、编辑辅助及文档摘要 | 两处相同的编辑器上下文 trace 交给一个局部构造函数，检索分支共用扩展来源计算，单次使用的查询转发函数内联到调用处。 |
| `src/retrieval/retrieval.service.ts` | 多查询召回、融合、重排与压缩 | 按模式构造召回列表后，融合输入统一拼接已有列表。当前文档的多个查询复用关键词文档列表。 |
| `src/retrieval/chunker.ts` | 索引、摘要和记忆使用的结构化分块 | 复用已计算的源码起止位置，同一原文块的多次切分共用受保护范围。保留结构边界、原文坐标和超预算异常。 |
| `src/wiki/wiki.service.ts` | 知识沉淀、检索和来源证明 | 来源去重及引用重绑定复用已经计算的来源坐标键，保留原有匹配顺序和首个匹配结果。 |
| `src/indexing/index-jobs.service.ts` | 文档索引任务入队与状态流转 | 同版本历史同时用于活跃任务检查与 generation 计算，减少一次历史查询。数据库分支继续由 Repository 在事务内去重并计算 generation。 |
| `src/workspace/workspace.service.ts` | 分类、回收、恢复及模板操作 | 分类变更和文档清理共用写入入口，集中保留数据库事务与按用户串行化。直接返回只作转发的异步结果。 |

## 核心调用链中的保留结论

“保留”表示该文件的现有职责及关键控制流程具备实际调用需求。本轮审查关注实现复杂度和可合并部分，具体业务正确性由下述回归覆盖提供证据。

### 编辑器、会话与页面

| 文件（相对 `livedoc`） | 核查结论 |
| --- | --- |
| `src/hooks/useArticleSession.ts` | 保留。文章自动保存、发布前等待在途保存、账户隔离和本地恢复各自处理不同生命周期，适合继续与知识文档会话分开。 |
| `src/lib/knowledge-editor.ts` | 保留。图片持久化、URL 稳定化、水合和释放已经共用，编辑器预览与持久化内容需要分别处理。 |
| `src/lib/article-draft.ts` | 保留。恢复数据校验、发布约束和错误提示职责集中。 |
| `src/lib/document-agent-editor.ts` | 保留。快照映射、目标冲突检测、候选 Decoration、采纳事务和一次撤销分别承接编辑生命周期中的不同阶段。 |
| `src/components/Knowledge/useRagChatSession.ts` | 保留。集中管理问答流、停止、引用定位、插入及反馈，复用本轮共用传输层。 |
| `src/components/Knowledge/AgentMarkdown.tsx` | 保留。Markdown 渲染、来源按钮和表格容器承担展示适配。 |
| `src/lib/remark-agent-citations.ts` | 保留。代码、已有链接、转义括号和引用标识的处理存在实际差异。 |
| `src/pages/editor/draft.tsx` | 保留现用入口。核对知识文档与文章会话切换、Agent 身份、工具栏及快捷键接线。 |
| `src/pages/editor/config/editorConfig.ts` | 保留。核对实际注册的编辑器扩展、粘贴处理、目录与代码块配置。 |
| `src/pages/knowledge/index.tsx` | 保留。核对列表筛选、分类、导入状态轮询、索引轮询及操作入口。 |
| `src/components/Knowledge/WorkspaceNavigation.tsx` | 保留。分类树、版本化变更、回收恢复及模板操作有各自的业务要求。 |
| `src/api/articles.ts` | 保留。文章草稿、发布、图片及互动接口保持直接调用，适合维持明确的业务方法。 |
| `src/api/workspace.ts` | 保留。分类与模板请求封装较薄，复用同一 HTTP 客户端。 |
| `src/contexts/authContext.tsx` | 保留。认证弹窗、延后执行的操作、登出及未授权事件集中管理。 |
| `src/utils/AISuggestionBus.ts` | 保留。现有写作工具栏、气泡及建议预览之间有实际订阅关系。 |
| `src/hooks/use-mobile.ts` | 保留。核查为兼容导出，调用方仍使用该路径。 |
| `src/hooks/use-tiptap-editor.ts` | 保留。核查为兼容导出，工具栏仍使用该路径。 |
| `src/lib/tiptap-utils.ts` | 保留。核查为工具栏使用的兼容导出路径。 |
| `src/App.tsx` | 保留。认证 Provider 与登录弹窗接线清楚。 |
| `src/router/index.tsx` | 保留。合并现有前后台路由与兜底路由。 |
| `src/router/frontRoutes.tsx` | 保留。承接文件路由生成器的导出。 |
| `src/router/adminRoutes.tsx` | 保留。静态首页与动态管理路由有实际来源。 |
| `vite.config.ts` | 核查自动路由排除规则和实际页面入口。 |

### Agent、RAG 与记忆

| 文件（相对 `livedoc_server_nest`） | 核查结论 |
| --- | --- |
| `src/ai/agent-supervisor.service.ts` | 保留。依赖就绪、并发批次、补查次数和最终交付预算共同限定调度行为。 |
| `src/ai/agent-runtime.types.ts` | 保留。Worker 状态与单例服务分离，取消包装处理不可取消工作迟到的情况。 |
| `src/ai/agent-handoff.ts` | 保留。结构校验、实际观察、采用引用和覆盖状态分别提供交接约束。 |
| `src/ai/document-agent.validation.ts` | 保留。模式权限、计划依赖、生成格式、引用和修改范围均有对应输入边界。 |
| `src/ai/document-agent-recovery.ts` | 保留。根据原始指纹恢复尚未处理的目标，位置不唯一时拒绝错误重绑定。 |
| `src/ai/graph/agent-graph.service.ts` | 保留。后台执行生命周期、用户暂停停止、来源复核与任务恢复相互配合。 |
| `src/ai/graph/agent-run.repository.ts` | 保留。命令幂等、行锁、执行代次、租约、事件序号和预算结算具有持久化约束。 |
| `src/ai/graph/mysql-checkpoint-saver.ts` | 保留。检查点、pending writes 与历史版本兼容属于已实现的恢复协议。 |
| `src/ai/agent-tools.service.ts` | 保留。模型选工具、显式意图和规则回退具备不同配置入口。 |
| `src/ai/llm.service.ts` | 保留。普通生成、工具会话、搜索与模型适配保持各自的供应商协议。 |
| `src/ai/document-summary.service.ts` | 保留。直接摘要、Map/Reduce、实际上下文预算和收敛检查服务于长文输入。 |
| `src/ai/agent-mcp.service.ts` | 保留。工具白名单、分页注册、失败清理和客户端关闭有实际生命周期。 |
| `src/ai/agent-settings.service.ts` | 保留。个人密钥加密、配置版本、能力验证与运行时开关分别承担现有要求。 |
| `src/ai/memory.service.ts` | 保留。完整对话轮次和旧消息的兼容路径对应现有调用及存量数据。 |
| `src/retrieval/vector-store.service.ts` | 保留。Qdrant 与内存模式分别提供现用环境和受控测试的实现。权限和版本激活检查保留。 |
| `src/retrieval/sparse-embedding.service.ts` | 保留。词频权重、哈希冲突合并和唯一有序索引满足稀疏向量要求。 |
| `src/retrieval/context-compressor.service.ts` | 保留。结构单元、相关性选择与实际拼接后的 Token 计数有独立作用。 |
| `src/retrieval/embedding-chunks.ts` | 保留。正式索引与离线导出复用同一分块和真实 tokenizer 预算。 |
| `src/retrieval/markdown-structure.ts` | 保留。AST 原文位置与内联原子范围为分块、压缩提供共同边界。 |
| `src/retrieval/code-boundaries.ts` | 保留。JS/TS 语法边界与其他语言的完整行回退覆盖不同输入。 |
| `src/inference/embedding.service.ts` | 保留。单条调用已经复用批量调用，真实模式与受控实现有明确配置边界。 |
| `src/inference/reranker.service.ts` | 保留。模型评分与启发式评分适用于不同运行模式。 |
| `src/inference/inference-worker.service.ts` | 保留。待处理请求、超时、退出清理和关闭状态是线程请求生命周期的一部分。 |

### 导入、队列与业务数据

| 文件（相对 `livedoc_server_nest`） | 核查结论 |
| --- | --- |
| `src/jobs/persistent-job-store.ts` | 保留。索引、导入与文档记忆已经共用领取、状态完成及任务清理实现。 |
| `src/indexing/index-jobs.repository.ts` | 保留。事务内去重、generation 计算及唯一键冲突后的读取承接并发入队。 |
| `src/indexing/index-worker.service.ts` | 保留。索引前后版本检查、租约确认和版本激活分别处理运行期间的状态变化。 |
| `src/document-imports/document-imports.service.ts` | 保留。数据库事务确认与内存确认的存储操作不同，均有对应调用和回归。 |
| `src/document-imports/import-worker.service.ts` | 保留。解析、图片持久化、视觉分析、取消检查和失败清理各自有副作用边界。 |
| `src/document-imports/docling-parser.service.ts` | 保留。外部解析进程参数、超时和输出文件清理较集中。 |
| `src/document-imports/vision.service.ts` | 保留。图片描述失败会返回独立状态，供导入流程决定后续处理。 |
| `src/documents/documents.service.ts` | 保留。读写权限、内容版本、索引状态及工作区投影各自承担业务边界。 |
| `src/documents/assets/assets.service.ts` | 保留。资产所有权、关联、引用协调和实际文件删除有各自顺序要求。 |
| `src/documents/document-access.ts` | 保留。共享文档访问判断已经集中。 |
| `src/documents/document-memory/document-memory.service.ts` | 保留。证据、置信度、版本匹配及条目合并共同决定可使用的文档记忆。 |
| `src/documents/document-memory/document-memory-jobs.service.ts` | 保留。任务存储已复用共用实现，版本替代与记忆状态更新保留在业务服务。 |
| `src/documents/document-memory/document-memory-worker.service.ts` | 保留。增量提取、批次预算和提取后的版本检查服务于不同阶段。 |
| `src/articles/articles.service.ts` | 保留。文章草稿与公开投影、发布事务、撤回、索引及图片清理有明确的独立职责。 |
| `src/articles/article-interactions.service.ts` | 保留。公开状态复核、评论幂等、回复层级和作者权限有对应业务规则。 |
| `src/auth/auth.service.ts` | 保留。会话过期、令牌哈希、密码校验及身份解析相互配合。 |
| `src/auth/auth.guard.ts` | 保留。统一解析身份并生成访问上下文。 |
| `src/database/document-catalog.ts` | 保留。重排前再次依据当前文档权限和激活版本筛选候选。 |
| `src/storage/blob-storage.ts` | 保留。上传限制、流式计量、临时文件与路径边界属于实际存储要求。 |
| `src/main.ts` | 保留。入口完成请求限制、跨域、校验和后台任务启动接线。 |
| `src/worker.ts` | 保留。索引与记忆轮询共用应用生命周期，单轮失败采用下一轮重试。 |
| `src/import-worker.ts` | 保留。导入任务与过期清理采用已有独立轮询周期。 |

## 入口核查与实现边界

`draft-page.tsx` 及分页示例被当前文件路由配置排除。`editorConfig-page.ts` 仍引用现用 `VirtualScroll.ts`，实验分页管理器与存储有自己的引用链。`VirtualScroll-page.ts` 与现用滚动实现存在重复片段。本轮对这些实验文件采用入口、引用与重复结构核查，保留其实验实现。

普通 Agent 与 Graph Agent 都由能力配置和页面选择进入，分别保留即时执行及持久化恢复的运行语义。兼容导出、旧消息记忆以及受控测试使用的内存存储均按实际调用关系保留。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 前端完整测试 | 10 个测试文件、55 个用例通过。 |
| 后端完整测试清单 | 分 8 个独立进程覆盖全部 32 个测试文件，345 个用例通过，11 个 MySQL 用例按现有开关跳过。 |
| 前端类型检查与生产构建 | 通过。 |
| 后端类型检查与生产构建 | 通过。 |
| Git diff 空白检查 | 按当前 CRLF 文件约定检查通过。 |

新增回归覆盖 UTF-8 字符跨块、CRLF 分帧、多行数据、回调失败、取消、普通 Agent 终态检查、Graph 序号、写作事件分发，以及知识文档各保存分支和两类预算结算。

既有回归覆盖 Agent 模式、主管依赖、预算、恢复、候选事务、引用权限、Wiki 联合覆盖与演进、结构分块、文档导入、索引任务、分类回收、文章发布及互动。

后端全部用例在单一 Jest 进程运行时出现内存耗尽，最终采用每批 4 个文件的独立进程完成验证。前端测试缓存使用项目目录以适配当前运行环境。

真实 MySQL 检查点运行、远程 Qdrant、实际模型及视觉解析服务仍采用单独的真实环境验收。本轮结果来自既有受控测试。前端构建输出包含现有 Sass 弃用、Lottie eval 与较大分包提示。
