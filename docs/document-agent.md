# 文档 Agent 与个人知识管理

前端入口：编辑器「AI 助手」或 Ctrl/Cmd + Shift + K；个人知识库侧栏提供分类、模板和回收站。

## 使用

- Ask 读取资料和回答，不提供正文修改；Plan 生成可调整计划，点击「按此计划执行」后才执行。
- 计划卡的「编辑计划」可手动修改目标、章节、写作要求与步骤，支持增删、排序和步骤类型。保存只更新当前计划；执行时发送保存后的计划及最新编辑器快照，用户确认版本优先于原始计划。
- 侧栏左边缘可拖动调宽，也可聚焦分隔条使用左右方向键；双击恢复默认宽度。宽度保存在当前浏览器，手机端保持全宽。
- 长文生成按内容选择表格、短段落、列表与重点。对比与指标汇总优先用 GFM 表格，`**术语**` 加粗，`==关键结论==` 高亮；纯文本或用户指定格式优先。侧栏预览、采纳、新草稿保存和重开均支持表格与高亮。
- Agent 可直接回答普通问题。输出位置只在用户要求写作或编辑时生效，不会把每轮提问都强制转换成正文修改；与原文相同的替换会被拒绝。
- Agent 发送前选择修改当前文档或新建独立文稿。修改通过正文标记和侧栏前后对比逐项采纳；全部接受为一次撤销操作。
- 正文、选区及光标上下文来自发送时的快照。后续手动编辑只让受影响建议冲突；切换文档取消任务。
- PDF/DOCX 使用既有解析 Worker，解析完成后作为资料，不自动入库。TXT/Markdown 按 UTF-8 读取，单文件 2 MiB，最多 10 份参考资料。
- 知识文档可按名称或内容搜索后选入资料。未选择知识库范围时不会强制检索公开知识库。
- 蓝色侧栏保留紧凑的输入框、模式与输出位置。点击书本图标在浮层中选择模板；资料和更多设置按需展开。
- 当前文档的模板浮层说明「按模板重组」，选择表示明确采用模板结构；具体用户需求和选区范围仍优先。新建文稿默认采用所选模板。
- 独立文稿采纳后保存为私有、未索引草稿，留在当前页面并提供编辑链接和 Markdown 下载。下载和保存保留所引用资料的来源。
- 引用来源只展示最终回答、文稿或修改建议实际采用的资料；其他读取记录另列。分页读取使用独立片段标识，保留当时的原文、版本与位置。回答中的引用编号可点击查看证据片段，再打开原文定位；版本或当前快照已变更时不自动定位到旧位置。
- 联网搜索摘要、逐条搜索片段及工具返回的链接按实际来源标示，不把多来源汇总登记成每个网页的原文。
- 个人分类最多三级，列表精确匹配直属分类；标签继续独立保留。删除分类默认把文档移到未分类，可选择一起回收。
- 分类合并是事务操作。恢复合并来源只恢复已清空的分类，不撤销已经迁移的文档。
- 回收文档保留正文和附件，普通检索、引用、资产及模型资料读取不能访问。恢复必要祖先链，按删除批次恢复，避免复活先前单独回收的内容。彻底删除才清理向量、附件、导入源、记忆及索引快照。

## 启用与迁移

保持现有模型、MySQL、Qdrant、解析 Worker 配置。先备份数据库，再在 NestJS 项目运行：

```powershell
npm install
npm run db:migrate
npm run build
```

当前 schema 版本为 `2026101901_agent_user_settings`，在工作台表及文档分类／回收字段的基础上增加个人能力配置表，不自动回填标签，也不自动清空回收站。

分类回填可使用知识库「导入旧标签目录」（仅当前用户），或执行全用户脚本：

```powershell
node --loader ts-node/esm scripts/backfill-categories.ts
```

回填按第一个非空标签创建一级分类，保留标签，跳过已分配分类、已回收文档和文章 projection，重复执行不覆盖人工归属。`全部文档`、`未分类` 为虚拟入口，不回填成实体分类。

软删除上线后，回退服务也必须保留删除状态的读取限制。关闭分类界面开关不清理或转换回收数据。

## 配置

```dotenv
DOCUMENT_AGENT_ENABLED=true
WORKSPACE_ENABLED=true
MCP_ENABLED=false
AGENT_WEB_SEARCH_URL=
AGENT_WEB_SEARCH_MODEL=
AGENT_MAX_TOOL_CALLS=12
AGENT_TIMEOUT_SECONDS=300
AGENT_MAX_OUTPUT_TOKENS=4096
AGENT_THINKING_SUPPORTED=false
AGENT_THINKING_ON_BODY={}
AGENT_THINKING_OFF_BODY={}
AGENT_CLASSIFIER_MODEL=
AGENT_PLAN_MODEL=
AGENT_CRITIC_MODEL=
```

联网检索可复用现有阿里云模型密钥：显式配置 `AGENT_WEB_SEARCH_URL` 为所在地域的原生 DashScope 多模态接口，例如 `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`。`AGENT_WEB_SEARCH_MODEL` 留空时使用主模型；部署前应验证该模型和端点支持联网检索及来源返回。工具 `search_web` 强制检索，引用只从接口返回的 `search_results` 建立，缺少来源时报错。`MCP_ENABLED=true` 可额外启用受控网页读取；原生搜索不依赖 Tavily 密钥或 MCP。每轮只有打开「联网检索」才加载和允许执行这些工具。协议说明见 [阿里云联网搜索文档](https://help.aliyun.com/zh/model-studio/web-search/)。

深度思考开启时主模型使用 `tool_choice=auto` 兼容思考与工具调用；普通文字不会直接写入编辑器，必要时通过一次关闭思考的结构化提交补齐终态。工具消息保留调用标识，服务端仅在本次工具对话内临时保留接口要求的推理字段，不写入会话记忆、审计或页面。分类、规划与自检仍使用各自的非思考配置。实际运行验证可执行 `node scripts/verify-agent-features.mjs`（使用本机常驻 API 和演示账号），覆盖思考、思考加联网、关闭联网三个场景。

辅助模型留空时复用主模型，需要支持对应 JSON／工具调用能力。`LLM_CONTEXT_WINDOW` 和 `TOKENIZER_ENCODING` 沿用现有预算配置；调整输出上限时同时核对模型窗口。长文分页读取，工具历史超出预算时压缩并保留引用和分页标识；仍超限则明确要求缩小范围，不把部分阅读称作全文结论。

深度思考只在已声明支持、正确配置请求参数时启用。例如支持 `enable_thinking` 的兼容服务可配置：

```dotenv
AGENT_THINKING_SUPPORTED=true
AGENT_THINKING_ON_BODY={"enable_thinking":true}
AGENT_THINKING_OFF_BODY={"enable_thinking":false}
```

开关作用于主模型；分类、规划、自检默认关闭思考。原始推理字段不进入前端或审计。

## MCP

启用 `MCP_ENABLED=true` 会注册本地受控 Fetch 服务，开发使用 TypeScript 脚本，生产使用构建后的 `dist/ai/mcp-fetch-server.js`。公网 DNS 结果及每次重定向均校验，连接使用校验过的地址；拒绝私网、回环、保留地址和携带用户密码的 URL。最多五次重定向，响应最多 2 MiB，只读取文字网页。

`MCP_SERVERS` 为 JSON 配置。Tavily 示例使用官方仓库当前声明的固定版本，部署时应核对安装来源：[官方 package.json](https://github.com/tavily-ai/tavily-mcp/blob/main/package.json)。

```dotenv
TAVILY_API_KEY=your-key
MCP_SERVERS={"tavily":{"enabled":true,"transport":"stdio","command":"npx","args":["-y","tavily-mcp@0.2.23"],"env":{"TAVILY_API_KEY":"${TAVILY_API_KEY}"},"tools_include":["tavily_search","tavily_extract"]}}
```

stdio 子进程只继承 SDK 的基本运行环境及明确配置的变量，不自动继承数据库、模型密钥。远程服务支持 `transport=streamable_http`、`url`、`headers`，URL 和请求头也支持 `${VARIABLE}` 替换。

只注册白名单工具，不依据第三方声明自动授予写权限。模型工具名包含服务器前缀，必要时规范化并加摘要，满足模型名称限制。发现失败清除该服务的部分注册，其他站内功能继续工作。前端联网默认关闭。

## 状态、审计和限制

`POST /ai/agent` 使用 SSE，返回路由、计划、步骤、工具、自检、候选和终态；增量只展示在侧栏。完整候选经过模式、区域、引用、Markdown 和编辑器节点校验后才可采纳。

- 同用户同时一个执行任务，每分钟最多十次启动；等待用户采纳不占执行名额。
- 计划最多五步，独立读取最多并发三个；每步四次工具调用，全任务默认十二次。
- 自检及工具修复各最多一次。自检失败或超时显示未完成，不跳过确定性校验，不重放写操作。
- 新文稿使用固定 ID，保存结果不确定时先查已有文档，避免重复创建。
- 反馈按任务串行合并，避免全部采纳时丢失其中一项；已处理候选不反向改写状态。
- 模板、分类只覆盖个人私有知识文档；文章草稿和团队／公开文档沿用原保存与管理入口。
- 首版为单 API 实例，限流与执行名额为进程内控制。审计正常使用 MySQL，工具审计故障记录日志，不重放工具。
- `GET /ai/agent/:id` 和 `/ai/tool-audits?run_id=...` 仅返回当前用户记录。运行表不保存完整快照或候选，不提供断点续跑和刷新后候选恢复。

## 验证

```powershell
npm run type-check
npm run build
npm test -- --silent
```

前端执行 `npm test`、`npx tsc -p tsconfig.app.json --noEmit` 和 `npm run build`。新增测试覆盖编辑事务、撤销、局部冲突、模式权限、计划／反思、思考参数、MCP 发现、源资料读取边界及回收恢复。

手工界面验证可运行 `node --loader ts-node/esm scripts/preview-document-agent.ts`，前端指向 `http://127.0.0.1:8009`。此脚本强制内存存储和固定模型响应，仅验证交互；不会使用生产数据库或真实模型，不代表真实模型质量评测。
