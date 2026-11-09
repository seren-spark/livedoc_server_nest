# 可恢复的文档 Agent（LangGraph v1）

采用 NestJS 内嵌 LangGraph 1.6.0、现有 MySQL 与 React 面板。旧的 `/ai/agent` 流式入口继续保留；不修改废弃后端和协同编辑。

## 启用

需要 Node.js 20+、MySQL 8 和现有模型配置。先备份业务库，再执行：

```powershell
npm install
npm run db:backup
npm run db:migrate
npm run build
```

迁移增加运行控制字段、检查点、pending writes、运行产物、事件和模型预算预留表。当前 schema 版本为 `2026110301_agent_graph`。即使暂不开启新任务，也应在部署新后端前完成迁移。

在现有 `.env` 中添加并重启 API：

```dotenv
AGENT_GRAPH_ENABLED=true
AGENT_GRAPH_RETENTION_DAYS=7
```

前端通过 capabilities 选择新入口。关闭 `AGENT_GRAPH_ENABLED` 只停止创建新图任务，已有图任务仍可查询、恢复和处理候选。图任务要求 MySQL，不降级为内存执行。

## 用户行为

- Plan 模式或明确要求“先给计划、确认后再写”的 Agent 任务会等待确认；普通 Agent 不增加确认。客户端给 Plan 请求附带 `confirmed_plan` 也不能跳过确认。
- 计划确认后保留原 `run_id` 与审计模式，由服务端转入 Agent 执行阶段。修改计划、回答澄清都提交到原任务。
- 关闭面板、切换文档和断线仅取消订阅，后台继续。重新打开时按用户和文档查询任务；同一浏览器标签页的未保存草稿标识在刷新后保持稳定。
- 暂停使用 RunControl drain，等待当前并行批次和检查点提交结束。恢复复用成功步骤；步骤内部未完成的模型请求可能重跑并产生额外费用。
- 停止会取消运行并使任务不可恢复。技术中断可以手动继续，预算和累计执行时长不重置。
- 当前文档修改保持原快照，继续使用块定位、编辑映射和冲突检测；正文不会自动采纳。选区无法可靠定位时要求重新生成。

## 编排与持久化

写作流程：prepare → make_plan → review_plan（可选 interrupt）→ decide_next → execute_step → compose → review_candidate → deliver。

多步骤沿用 Supervisor 的派发、补查、澄清和汇总协议。研究结果使用原 WorkerHandoff 的事实、缺口、冲突及来源校验。共享检索实现仍采用 Wiki 优先和原文回退。每个图研究步骤最多一次搜索，可继续追读原文；主管最多追加一次研究，不扩大授权范围。

并行步骤以稳定 step_id 合并产物。批次内可恢复失败会在成功结果提交后进入恢复等待点，因此不会因为同批另一步失败而重做已提交结果。

- `agent_runs` 是状态、版本、执行代次和预算汇总的统一入口，审计服务不调度图任务。
- MySQL Saver 实现完整的检查点与 pending writes 协议，使用同步持久化。
- 产物先落库，再由检查点引用。执行代次与租约在写事务内校验，旧实例不能提交迟到结果。
- 模型请求先事务预留、再幂等结算。未知用量按估算扣账，恢复不从旧检查点回滚账本。
- 交付候选沿用固定标识；会话记忆按来源任务去重。原始模型推理字段、登录 Token 和解密凭证不保存到图状态。
- 恢复前重新校验访问身份、引用版本和运行配置。运行中和排队任务不被清理；过期等待任务先失效，再清理其检查点和独占产物。已交付候选继续按原有规则保存。
- 首期单 API 实例。进程内每秒领取任务，租约 60 秒，每 20 秒续租。租约失效转为 interrupted，不自动重放；等待和暂停不占执行名额。

`thread_id` 等于服务端 run_id，聊天 conversation_id 不作为检查点标识。工作流版本固定 v1，不兼容部署前必须处理仍可恢复的任务。

## 接口

| 接口                                        | 用途                                                |
| ------------------------------------------- | --------------------------------------------------- |
| POST `/ai/agent/runs`                       | 创建任务；相同 request_id 返回已有任务              |
| GET `/ai/agent/runs`                        | 按 document_key 或 conversation_id 查询当前用户任务 |
| GET `/ai/agent/runs/:id`                    | 状态、阶段、版本、等待项和允许的操作                |
| GET `/ai/agent/runs/:id/events?after_seq=N` | 进度事件重放和 SSE 订阅                             |
| POST `/ai/agent/runs/:id/pause`             | 安全暂停                                            |
| POST `/ai/agent/runs/:id/resume`            | 继续、确认计划、修改计划或回答澄清                  |
| POST `/ai/agent/runs/:id/stop`              | 停止任务                                            |
| POST `/ai/agent/:id/restore`                | 复用现有候选恢复、访问校验和位置恢复                |
| POST `/ai/agent/:id/feedback`               | 复用现有采纳、拒绝与评价                            |

控制请求带 request_id、expected_revision；恢复动作是 continue / approve_plan / revise_plan / answer。等待输入时同时提交当前 interrupt_id。过期版本返回 409，相同控制请求可幂等重试。

事件只保存进度和交付通知，不重放来源正文或完整候选；前端在交付状态提交后，通过受权限校验的 restore 读取候选。SSE seq 持久化，重连不重新创建任务。

## 验证

```powershell
npm run type-check
npm run build
npm test -- --silent
npm run test:graph:checkpoints
npm run verify:graph:checkpoints
npm run test:graph:mysql
```

检查点脚本固定使用独立的 `livedoc_langgraph_test` 库；HTTP 集成脚本固定使用 `livedoc_langgraph_integration_test` 库。数据库账号需有创建测试库权限，也可用 GRAPH_TEST_DATABASE_URL 提供测试账号。脚本不会迁移或清理业务库。

真实模型检查使用现有模型密钥，固定写入 `livedoc_langgraph_real_test`，会产生模型费用：

```powershell
npm run verify:graph:real
```

该检查使用两个独立 Node 进程验证计划确认和恢复；检索验收首次只暴露一份真实索引资料，模拟证据缺口，再由真实模型决定补查。结果写入本地 `.tmp/graph-real-results.json`。

前端检查：

```powershell
cd ../livedoc
npm test -- src/api/document-agent-graph.test.ts src/lib/document-agent-editor.test.ts
npm run build
```

`docs/agent-graph-ui-check.cjs` 在测试前端 15173 端口使用受控 HTTP 响应验证刷新发现原任务、确认、暂停、继续及展示候选，不访问业务 API；截图输出 `docs/agent-graph-ui.png`。

浏览器验证前，先在 `livedoc` 目录启动测试前端：

```powershell
$env:VITE_RAG_API_BASE_URL='http://127.0.0.1:18005'
npm run dev -- --host 127.0.0.1 --port 15173
```

然后在项目根目录另开终端执行 `node docs/agent-graph-ui-check.cjs`。脚本需要本机已有的 Playwright 和 Edge。
