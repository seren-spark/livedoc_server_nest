# 模型路由与故障隔离

现有 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 和角色模型配置继续生效。新的部署配置可以为每个角色选择一组 OpenAI-compatible 模型 Profile。

## 配置示例

以下环境变量值为 JSON。凭证只通过环境变量名称引用。

```dotenv
LLM_MODEL_PROFILES={"primary":{"model":"deepseek-v4-pro-0813","base_url":"https://provider-a.example/v1","api_key_env":"MODEL_A_KEY","thinking":"toggle","thinking_on_body":{"enable_thinking":true},"thinking_off_body":{"enable_thinking":false},"tools":true,"json":true,"context_window":32768},"backup":{"model":"kimi-k3","base_url":"https://provider-b.example/v1","api_key_env":"MODEL_B_KEY","extra_body":{"temperature":1},"thinking":"toggle","thinking_on_body":{"enable_thinking":true},"thinking_off_body":{"enable_thinking":false},"tools":true,"json":true,"context_window":32768}}
AGENT_MODEL_ROUTES={"main":["primary","backup"],"classifier":["backup"],"plan":["backup"],"critic":["backup"]}
LLM_CIRCUIT_FAILURE_THRESHOLD=3
LLM_CIRCUIT_COOLDOWN_MS=30000
```

示例域名和能力声明需要替换并验证。备用型号的简单请求成功，仅表示该请求可用。工具调用、工具结果续接、JSON 与思考开关各自需要验收。

未显式配置的角色继承 `main` 路由。未配置 `main` 路由时，各角色沿用既有单模型配置。每条角色路由最多 16 个唯一 Profile，总 Profile 最多 64 个。

Profile 支持以下字段。

| 字段 | 含义 |
| --- | --- |
| `model` | 服务商模型 ID |
| `base_url` | OpenAI-compatible API 前缀，未填写沿用原地址 |
| `api_key_env` | 凭证环境变量名称，未填写沿用原全局 Key |
| `provider` | 可选的追踪标签，默认使用地址主机名 |
| `extra_body` | 服务商参数，可设置温度，模型／消息／工具等受控字段由服务端构建 |
| `thinking` | `off`、`toggle`、`always_on`，默认 `off` |
| `thinking_on_body`、`thinking_off_body` | 开关参数，思考能力按模式要求显式填写 |
| `tools`、`json` | 对应能力，默认开启；已知不支持时填写 `false` |
| `context_window`、`timeout_seconds` | 默认沿用既有配置 |

`always_on` Profile 仅参与开启思考的主模型任务。分类、规划和审核使用关闭思考的兼容 Profile。个人思考适配预设继续用于原配置路径；显式 Profile 使用部署声明的开关参数。验证个人思考配置时，固定选择可切换且支持工具的同一 Profile，检查开启、工具结果续接和关闭三次调用。

## 执行与预算

路由先按工具、JSON、思考开关、窗口和凭证过滤。兼容性过滤不会发送 HTTP。每次 `LlmService.agentTurn` 只发送一次 HTTP，后续模型选择由 AgentRuntime 的既有重试循环处理，每次实际尝试继续预留共享预算并记录 Trace。

根任务已经执行成功的工具保留在原交互历史中。模型回退仅继续当前模型回合，首次成功响应会立即返回。`maxAttempts=1` 的提取调用仍只有一次尝试。直接写作接口的 completion 和 stream 也使用主 Profile，保留单次调用行为。

原生联网搜索仍通过 `AGENT_WEB_SEARCH_URL`、`AGENT_WEB_SEARCH_MODEL` 和全局 `LLM_API_KEY` 调用。搜索端点与新主模型 Profile 的凭证分开管理。

## 错误与熔断

供应商错误正文被丢弃，保留固定错误分类和 HTTP 状态。支持欠费／额度、身份认证、限流、参数拒绝、服务不可用、超时、网络和无效响应分类。参数拒绝和无效响应停止当前回合，额度、认证及临时故障可由上层选择备用 Profile。

欠费和认证错误立即打开该 Profile 的熔断，其余可恢复错误达到阈值后打开。冷却期默认 30 秒，允许配置 1 至 300 秒。冷却后只允许一个半开探针，成功清除失败状态。熔断状态由单进程维护，多实例各自记录。

个人思考验证指纹绑定全部路由、模型能力、服务端点和实际凭证。部署切换或凭证轮换后，旧验证需要重新执行。指纹只输出哈希，配置摘要只输出 Profile 名称，不输出密钥。

## 验证

```powershell
npm test -- --runTestsByPath tests/model-governance.spec.ts tests/agent-model-options.spec.ts
npm run type-check
```

回归覆盖独立凭证与端点、角色隔离、能力过滤、上下文窗口、单次 HTTP、受控回退、熔断冷却、错误分类、搜索凭证隔离和指纹变化。真实模型验证由业务评测统一计数并执行。
