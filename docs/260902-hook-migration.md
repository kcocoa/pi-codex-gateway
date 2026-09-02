# Codex provider 迁移计划

> 目标：复用 Pi 官方 provider 的全部请求与标准响应能力。Pi 官方实现负责请求构造、认证、请求 headers、重试、transport、标准响应解析和高层消息生命周期；扩展只增加 Codex 功能，并在 SSE 模式下通过透明的 SSE response-body event hook 观察附加事件。
>
> `openai-codex` 不再被扩展强制使用 SSE。非 SSE transport 由 Pi 官方实现处理，但由于扩展没有 WebSocket event observer，额度/用量和远端 Cyber warning 会提示为不可靠。

## 1. 最终架构

```text
Pi official provider
  ├─ build request
  ├─ auth / request headers
  ├─ retry / timeout / abort
  ├─ SSE HTTP request
  ├─ response status / headers
  ├─ standard SSE parsing
  └─ standard AssistantMessage events

Pi official lifecycle hooks
  ├─ before_provider_request
  │    └─ fast.service_tier / web_search
  ├─ before_provider_headers
  │    └─ optional request header injection
  ├─ after_provider_response
  │    └─ HTTP status / response headers
  └─ message_update / message_end / turn_end
       └─ standard semantic state

Extension SSE response-body event hook
  └─ transparent fetch/body tap
       ├─ parse SSE framing and JSON only for observation
       ├─ codex.rate_limits
       ├─ response.metadata
       ├─ codex.response.metadata
       └─ body-event server-model signals
```

关键边界：

- 官方 provider 仍然拥有真正的请求和标准响应解析流程。
- 扩展不重新构造 request payload，不实现 retry，不生成 assistant message。
- `after_provider_response` 处理 response headers；body-event hook 处理 response body。
- body-event hook 只是一个 hook-like adapter，不是第二个 provider。
- SSE body 的每个字节必须继续原样交给 Pi 官方 parser。

## 2. 功能与信号来源

### 2.1 Fast

- [x] 使用 `before_provider_request` 注入 `service_tier`。
- [x] 确认 fast 与 SSE body observer 无关。
- [x] 确认 provider wrapper 中没有重复注入 `service_tier`。
- [x] 保持 `/codex:fast`、配置持久化、completion 和 footer 状态行为不变。

### 2.2 Quota

Quota 有两个合法来源：

1. HTTP response headers；
2. SSE response body 中的 `codex.rate_limits`。

- [x] HTTP headers 使用 `after_provider_response`。
- [x] body events 使用 SSE response-body event hook。
- [x] 两种来源都进入同一个 quota state/apply 函数。
- [x] 保持 primary/secondary window、reset、credits、plan、promo 和 reached-type。
- [x] 处理 header snapshot 与 body snapshot 的重复更新。
- [x] 处理 retry 时多次 response 的更新顺序。
- [x] `/codex:usage` 继续显示所有已观察数据。
- [x] footer 状态显示和 countdown 行为不变。

### 2.3 Cyber warnings

Cyber warning 也有两个来源：

1. HTTP response headers 中的 `openai-model` / `x-openai-model`；
2. SSE body 中的模型 metadata 和 `trusted_access_for_cyber`。

- [x] HTTP model signal 使用 `after_provider_response`。
- [x] body model signal 使用 SSE body event hook。
- [x] `trusted_access_for_cyber` 使用 body event hook。
- [x] 两种模型 signal 进入同一个 warning decision 函数。
- [x] 保持 `warn`、`stop`、`stop-after-repeat` 策略。
- [x] 保持按 warning key 去重。
- [x] 同一个 signal 同时出现在 headers/body 时只通知一次。
- [x] stop 策略仍然只 abort 当前 turn。

### 2.4 标准响应状态

- [x] usage 使用 `message_end` / `turn_end` 的最终消息。
- [x] response ID 使用标准 assistant message。
- [x] stop reason 使用标准消息生命周期。
- [x] 不从 body observer 重复构造标准 assistant event。
- [x] body-only signal 不写入 prompt、工具参数或完整 raw frame。

## 3. 阶段一：建立迁移基线

### 3.1 测试边界

本次不重复验证 Pi 官方 provider 的请求流和标准响应流。以下内容视为 Pi 的职责并直接信任：

- 请求构造和序列化；
- request headers、认证和 transport 选择；
- retry、timeout、abort 和错误分类；
- SSE body 的官方消费和标准事件映射；
- 标准文本、thinking、tool call、usage、response ID 和 stop reason 生命周期。

扩展测试只覆盖扩展自己新增或修改的逻辑：

- [x] `codex-sse.test.ts` 只保留最小的 SSE body event tap / 原样透传测试；
- [x] `rate-limits.test.ts` 只测试扩展自己的 quota event/header 解析；
- [x] `codex-signals.test.ts` 只测试扩展自己的模型/Cyber signal 解析；
- [x] `quota-display.test.ts` 只测试 quota state 合并和 UI 格式化；
- [x] Cyber warning 测试只测试 warning policy、去重和 abort decision；
- [x] `codex-provider.test.ts` 只测试 provider matching/label，不测试官方请求流。

明确删除或不新增：

- [x] provider response stream integration tests；
- [x] 对 Pi 官方 parser 的完整文本/thinking/tool call 流程测试；
- [x] 对 Pi 官方 retry/timeout/abort/transport 行为的重复测试；
- [x] 通过 mock provider 复制 Pi 请求流的测试；
- [x] 依赖完整原始 response stream fixture 的扩展回归测试。

### 3.2 一次性真实 smoke check

- [x] 保留脱敏官方 hook 探针：`experiments/official-hooks-probe.ts`。
- [x] 已使用独立 agent 目录和临时认证副本验证 hook 能力。

> 自动化测试和离线 bundle 已完成；真实 provider smoke check 仍需在具备认证的独立 agent 目录中手动执行，避免在本次修改中读取或消耗用户凭据。

- [ ] 迁移完成后只做一次最小 smoke check，确认扩展能加载、hook 能触发、body tap 不干扰请求。
- [ ] smoke check 只记录结构、长度、状态和必要 signal，不保存 prompt、工具参数、token 或完整事件帧。
- [ ] smoke check 不作为对 Pi 官方请求流的长期回归测试。

## 4. 阶段二：把 body observer 明确为 hook

### 4.1 命名与接口

- [x] 将 `CodexGatewayStreamEventHandler` 改名为更明确的名称，例如：
  - [x] `SseBodyEventHandler`；或
  - [ ] `CodexResponseBodyEventHandler`。
- [x] 将 `createObservedFetch()` 改名为更明确的名称，例如：
  - [ ] `createSseBodyEventHookFetch()`；或
  - [x] `createSseEventTapFetch()`。
- [x] 在接口注释中明确：这是 response-body observation hook，不是完整 transport provider。
- [x] handler 只接收解析后的 JSON object，不暴露完整 raw body。
- [x] handler 不返回或替换官方 response。

### 4.2 保持官方 request/response ownership

- [x] body hook 继续调用传入的原始 `fetch`。
- [x] 不构造或修改 request URL、method、headers、payload。
- [x] 不实现 retry、backoff、timeout、abort 或错误分类。
- [x] 不调用官方 parser 以外的高层 response mapping。
- [x] 不改变 Pi provider 传入的 `RequestInit`。
- [x] 不改变 response status、statusText 或 headers。

### 4.3 SSE body passthrough

- [x] 只对 `content-type` 包含 `text/event-stream` 的 response 安装 body tap。
- [x] 使用 `TransformStream` 或等价机制旁路读取 chunk。
- [x] 每个输入 chunk 原样 enqueue。
- [x] 正确处理 UTF-8 多字节字符跨 chunk 的情况。
- [x] 正确处理 LF 和 CRLF。
- [x] 正确处理 SSE 空行分隔事件。
- [x] 正确处理多个 `data:` 行。
- [x] 正确忽略 `[DONE]`。
- [x] stream flush 时处理剩余 buffer。
- [x] observer 抛异常时仍继续转发 body。
- [x] observer 解析失败时不影响官方 parser。
- [x] 非 SSE response 原样返回，不创建 transform。

### 4.4 移除重复的 HTTP observation

- [x] 从 body hook 中删除 HTTP response status/header 的业务处理。
- [x] 删除 `CODEX_GATEWAY_ERROR_RESPONSE_EVENT`，或先标记 deprecated 再删除。
- [x] 非 2xx response 由 `after_provider_response` 统一处理 headers。
- [x] provider 官方实现继续负责读取 error body 和生成最终错误。
- [x] `rate-limits.ts` 不再依赖 synthetic error event 取得 response headers。
- [x] body hook 只处理 response body events。

## 5. 阶段三：统一业务入口

### 5.1 Quota support

- [x] 在 `quota-display.ts` 增加明确的 response-header 入口：
  - [x] `handleResponseHeaders(headers, ctx)`。
- [x] 保留 body event 入口：
  - [x] `handleBodyEvent(event, ctx)`。
- [x] 两个入口都转换为 `RateLimitUpdate`。
- [x] 两个入口都调用唯一的 `applyUpdate()`。
- [x] 增加来源标记：`response_headers` / `sse_body_event`。
- [x] 对相同 snapshot 做幂等处理。
- [x] 防止旧 retry 数据覆盖较新的 quota 数据。
- [x] 测试 header-only、body-only、header+body 和重复事件。

### 5.2 Cyber warning support

- [x] 在 `cyber-warning.ts` 增加明确的 response-header 入口：
  - [x] `handleResponseHeaders(headers, ctx)`。
- [x] 保留 body event 入口：
  - [x] `handleBodyEvent(event, ctx)`。
- [x] 两个入口都调用同一个 server-model/warning decision 函数。
- [x] `trusted_access_for_cyber` 只从 body event 提取。
- [x] 同一 turn 中保持 warning key 去重。
- [ ] 测试 header signal 与 body signal 的时序差异。
- [x] 测试 warning action 对 abort 的影响。

### 5.3 `index.ts` wiring

- [x] 保持 `index.ts` 负责扩展初始化和 provider 注册。
- [x] 保持 `before_provider_request` 中的 fast/web-search 请求增强。
- [x] 不把 quota/warning 解析搬到 `index.ts`。
- [x] 不让 `index.ts` 直接解析 SSE event。
- [x] 只负责把 body hook 连接到 quota/cyber support。

## 6. 阶段四：简化 provider wrapper

### 6.1 `providers/openai-codex.ts`

- [x] 继续调用 Pi 官方 `openAICodexResponsesApi()`。
- [x] 不覆盖 Pi 的 transport 配置；SSE body-event hook 仅在 SSE/fallback 路径生效。
- [x] wrapper 只做两件事：
  - [x] 传递官方 provider options；
  - [x] 将 `fetch` 替换为透明 SSE body event hook。
- [x] 不在 wrapper 中构造 payload、headers、retry 或错误。
- [x] 原样保留 `options.fetch`、signal、timeout、session ID 和其他 options。
- [x] 验证官方 response body 字节不被修改。

### 6.2 `providers/codex-gateway.ts`

- [x] 继续调用官方 `openAIResponsesApi()`。
- [x] 保留 gateway provider 的模型目录、base URL 和 API-key auth。
- [x] 删除重复的 HTTP status/header observation。
- [x] wrapper 只注入 SSE body event hook。
- [x] `stream` 和 `streamSimple` 共享同一个透明 body hook helper。
- [x] 不复制 `openai-responses` 的 request builder 或 response parser。

### 6.3 `codex-sse.ts`

- [x] 只保留 SSE framing、JSON event observation 和 body passthrough。
- [x] 移除与 response headers、quota synthetic event、错误分类相关的代码。
- [x] 保持 `safeEmit()` fail-open。
- [x] 保持 observer 不影响官方 stream 取消、结束和异常。
- [x] 重新命名导出，避免让文件看起来像完整 Codex provider。

## 7. 阶段五：测试计划（只覆盖扩展自有逻辑）

测试目标不是证明 Pi 的请求流完整，而是证明扩展新增的 body-event hook 和业务状态处理不破坏 Pi 的输入输出。

### 7.1 最小 SSE body event tap 测试

只保留 `codex-sse.ts` 中扩展自有逻辑的最小测试：

- [x] 一个 SSE event 能被观察到；
- [x] event 被拆在多个 chunks 中仍能被观察到；
- [x] CRLF/LF 和 `[DONE]` 不导致错误 signal；
- [x] 非 SSE response 不被改写；
- [x] observer 抛异常时 body 仍然透传；
- [x] 官方消费者看到的 body 字节与输入一致。

不测试：

- [x] Pi 官方 parser 如何解析文本/thinking/tool call；
- [x] 完整 provider response stream；
- [x] provider retry、timeout、abort 或 transport fallback；
- [x] 扩展内部复制一套 assistant event stream。

### 7.2 纯 signal 和业务状态测试

- [x] `codex.rate_limits` → quota state；
- [x] quota response headers → quota state；
- [x] 相同 quota 由 headers/body 同时提供时幂等且不回退；
- [x] `response.metadata` → server-model signal；
- [x] `codex.response.metadata` → server-model signal；
- [x] `trusted_access_for_cyber` → warning policy；
- [x] HTTP `openai-model` / `x-openai-model` → warning policy；
- [x] 同一 turn 多次 warning 去重；
- [x] `stop` / `stop-after-repeat` 的 decision 和 abort 调用；
- [x] quota footer/status 和 `/codex:usage` 的格式化。

这些测试使用纯 event/header fixture，不启动 Pi provider，不模拟完整请求流。

### 7.3 一次性 smoke check

- [ ] 使用独立 `PI_CODING_AGENT_DIR`。
- [ ] 使用手动准备的认证副本，不读取或打印认证内容。
- [ ] 只加载测试扩展和必要的内置 Pi 组件。
- [ ] 确认 `openai-codex` 和 `codex-gateway` 的官方 hook 能触发。
- [ ] 确认 SSE body tap 能收到附加 event 且不影响官方响应。
- [ ] 确认 `/codex:fast`、quota footer、`/codex:usage` 和 Cyber warning 至少走通一次。
- [ ] 检查日志不包含 prompt、工具参数、Authorization、Cookie 或完整事件帧。
- [ ] 诊断日志权限保持为 `600`。
- [ ] smoke check 完成后不再新增 provider response stream 回归测试。

## 8. 阶段六：文档与清理

- [x] 更新 README 的 provider behavior：
  - [x] Pi 官方实现负责 HTTP request/standard response；
  - [x] 扩展只观察 SSE response body 附加事件；
  - [x] SSE body-event hook 只在 SSE/fallback 路径保持 response-body event 可观察；
  - [x] fast 使用 request hook；
  - [x] quota/warning 同时可能来自 response headers 和 body events。
- [x] 保持 transport 设计文档与本次 SSE body hook 迁移边界一致。
- [x] 更新 `codex-sse.ts`、provider wrapper 和 feature module 注释。
- [x] 删除已经不再需要的 synthetic event 类型和测试。
- [x] 删除重复的 header parsing 路径。
- [x] 检查 public exports 和命名是否反映“body event hook”职责。
- [x] 运行完整测试、Biome 和 Bun build。
- [x] 检查 `git diff`，确认不覆盖 `footer.ts` 的既有修改。

## 9. 完成标准

迁移完成必须满足：

- [x] Pi 官方 provider 仍负责所有 request、retry、timeout、abort 和标准 response parsing。
- [x] fast/web search 只通过官方 request hook 注入。
- [x] HTTP response headers 只通过 `after_provider_response` 处理。
- [x] 自定义 wrapper 不再构造 request 或实现错误分类。
- [x] SSE body event hook 能观察 Codex 附加事件。
- [x] SSE body 字节对官方 parser 完全透明。
- [x] quota header、quota body event、Cyber header、Cyber body event 都有覆盖。
- [x] observer 异常不会影响正常响应。
- [x] body observer 异常不会影响官方响应 body。
- [ ] fast、quota、warning、image generation、web search 的扩展逻辑无回归。
- [ ] quota/header/body signal 合并和 warning 去重符合预期。
- [x] 不记录或持久化敏感原始内容。
- [x] 不新增或维护 Pi 官方 provider response stream 测试。
