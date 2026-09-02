# WebSocket 实施方案与困难

> 状态：`openai-codex` 不再强制使用 SSE；非 SSE 配置会启用 Pi 官方的
> WebSocket transport，但当前扩展仍无法旁路观察 WebSocket 帧。因此启动时会
> 提示额度/用量和远端 Cyber warning 在 WebSocket 响应中不可用。可通过
> `/settings` → `Transport` → `SSE`，或在 `~/.pi/agent/settings.json` 中设置
> `"transport": "sse"` 恢复。

## 1. 背景与结论

`openai-codex` 当前通过 Pi 官方的 `openai-codex-responses` 实现发送请求。
`providers/openai-codex.ts` 不覆盖 Pi 传入的 transport 配置：`sse` 仍可使用
当前的 SSE 旁路观察，`auto`、`websocket` 或 `websocket-cached` 则由 Pi 官方
实现处理。原因是 Pi 当前没有向扩展暴露 WebSocket 原始事件的正式观察接口。

OpenAI Codex 官方实现会在 WebSocket 中处理以下数据：

- `response.metadata` 和 `codex.response.metadata`；
- `codex.rate_limits`；
- `openai-model` / `x-openai-model`；
- `trusted_access_for_cyber` 模型验证信息；
- 带状态码和 headers 的错误事件；
- WebSocket 连接复用、turn state 和模型路由信息。

主要对照代码：

- OpenAI Codex：`codex-rs/codex-api/src/endpoint/responses_websocket.rs`
- OpenAI Codex 事件抽取：`codex-rs/codex-api/src/sse/responses.rs`
- Codex WebSocket 测试：`codex-rs/core/tests/suite/client_websockets.rs`
- Pi WebSocket 实现：`packages/ai/src/api/openai-codex-responses.ts`
- Pi 请求选项：`packages/ai/src/types.ts`

因此，问题属于**扩展接入点不足**，不是协议能力不足。

## 2. 目标

WebSocket 方案必须满足：

1. 继续使用 Pi 官方请求构造、重试、连接缓存和事件解析逻辑；
2. 不复制或 fork Pi 的 `openai-codex-responses` 实现；
3. 保留当前扩展的请求增强、Cyber warning、模型路由检测和额度监控；
4. 观察器出现异常时不能破坏正常回答流；
5. 不记录 prompt、tool 参数、OAuth token 等敏感原始内容；
6. 能正确处理连接复用、重连、取消和多个请求。

## 3. 当前 SSE 方案作为基线

SSE 目前使用的是正式的 `fetch` 注入点，不需要全局 monkey patch：

- `createSseEventTapFetch()` 调用原始 `fetch`；
- 对 SSE response body 增加 `TransformStream`；
- 旁路解析 JSON 事件；
- 将原始字节继续传递给 Pi 官方 SSE 解析器；
- HTTP headers 通过 `after_provider_response` 观察。

因此生产默认方案仍应是 SSE。WebSocket 只应作为明确的可选传输方式。

## 4. 推荐方案：为 Pi 增加正式 observer hook

最干净的方案是在 Pi 的通用 provider 选项中增加传输事件观察接口，而不是在
扩展中拦截全局 WebSocket：

```ts
interface TransportObserver {
  onEvent?: (event: unknown, info: {
    transport: "sse" | "websocket";
    model: string;
    sessionId?: string;
  }) => void;
  onError?: (error: unknown, info: { transport: string }) => void;
}
```

Pi 官方实现应在完成 JSON 解析、交给高层事件映射之前调用 `onEvent`。SSE 和
WebSocket 共用同一个接口，扩展就不需要重复实现两套协议解析器。

如需观察 WebSocket 握手 headers，可另外增加结构化的连接信息回调；不应要求
扩展自行读取底层 HTTP Upgrade 响应。

这个改动的优点：

- 不修改官方解析流程；
- 不污染全局运行时；
- 事件天然带有 model/session/transport 上下文；
- 可以正确处理连接复用和并发；
- 扩展只需复用现有的 `handleBodyEvent()`。

这是长期维护的首选方案。它可以作为一个小型上游 PR，而不是维护 Pi fork。

## 5. 无 Pi 修改时的备选方案：包装 WebSocket 构造函数

如果必须只修改扩展，可以在 Pi 首次创建 WebSocket 之前包装
`globalThis.WebSocket`：

1. 扩展启动时保存原始构造函数；
2. 安装一次包装器；
3. 只匹配 Codex WebSocket URL；
4. 创建 socket 后增加 `message`、`error`、`close` 监听；
5. 将文本、`Blob` 或 `ArrayBuffer` 转换为 JSON；
6. 对已知事件调用现有 signal handler；
7. 不修改事件对象，也不阻止官方监听器；
8. 观察器异常全部吞掉，保证 fail-open。

示意结构：

```ts
const OriginalWebSocket = globalThis.WebSocket;

class ObservedWebSocket extends OriginalWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    attachObserver(this, String(url));
  }
}

globalThis.WebSocket = ObservedWebSocket as typeof WebSocket;
```

实际实现不能只按上述示例完成，还必须保留 Pi 运行时使用的构造参数，包括
可能携带 headers 的第三参数或运行时扩展参数。

### 主要困难

#### 5.1 全局状态和加载顺序

Pi 会缓存 WebSocket 构造函数。包装必须早于第一次 provider 请求，否则已经缓存的
原始构造函数不会经过观察器。全局替换还可能影响 Pi 或其他扩展创建的无关 socket。

#### 5.2 Bun/Node 运行时差异

不同运行时的 WebSocket 构造函数、事件对象和自定义 headers 参数并不完全一致。
Pi 的实现还可能通过继承原生 WebSocket 添加代理支持，因此需要分别测试 Bun、Node
以及代理配置。

#### 5.3 请求与上下文关联

观察器看到的是 socket，而不是 Pi 的 `ExtensionContext`。单纯使用全局
`activeContext` 在连接复用或并发请求时可能把事件归属到错误的 turn。

至少需要跟踪：

- socket 到 session 的关联；
- 发出的 `response.create` 请求；
- response id / turn state；
- 连接重用和重连；
- turn 开始、完成、取消和错误。

#### 5.4 握手 headers 不透明

标准 JavaScript WebSocket API 通常不会暴露 HTTP Upgrade 响应 headers。因此，
仅包装构造函数未必能取得握手阶段的 `openai-model` 等信息。应优先使用事件帧中
的 metadata；如果某个功能必须依赖握手 headers，则需要 Pi hook、运行时私有 API
或本地代理。

#### 5.5 事件重复和时序

Pi 官方解析器和扩展观察器会同时收到同一帧。观察器必须是只读的，不能调用
`preventDefault()`、改写 `event.data` 或消费 socket body。额度和 warning 处理
还需要去重，避免重连或重复 metadata 导致重复通知。

#### 5.6 安全与隐私

WebSocket 帧可能包含用户输入、工具调用参数和模型输出。实现不得默认打印或
持久化原始帧，只提取以下字段：

- `type`；
- `metadata.openai_verification_recommendation`；
- `rate_limits`；
- 需要的模型 headers；
- 结构化错误信息。

不得记录 Authorization、Cookie、完整 prompt 或工具参数。

## 6. 另一种备选：本地 WebSocket 代理

本地代理可以在 HTTP Upgrade 层和 WebSocket 帧层同时观察数据：

```text
Pi -> local proxy -> chatgpt.com WebSocket
```

优点：

- 不需要修改 Pi 或替换全局 WebSocket；
- 可以读取握手状态和 headers；
- 可以统一记录连接、帧和错误生命周期。

缺点：

- 需要额外进程或后台服务；
- 要处理 TLS、认证 headers、代理转发和进程退出；
- 增加本地攻击面和部署复杂度；
- 连接缓存、超时和取消行为更难保持完全一致。

除非确实需要握手 headers，否则不建议为了扩展功能引入代理。

## 7. 不建议的方案：复制官方 provider

自行实现 WebSocket provider 可以获得最强控制力，但需要持续同步 Pi 官方实现的：

- 请求字段和压缩；
- 连接缓存与 session affinity；
- 重试和 SSE fallback；
- continuation/turn state；
- 事件映射；
- 错误分类和取消行为。

这会把一个观察需求扩大为完整协议实现，不符合本扩展“尽量复用官方实现”的目标。

## 8. 当前状态与后续计划

### 当前 transport 行为

- `transport: "sse"`：使用 `createSseEventTapFetch()`，保留完整的现有观察能力；
- `transport: "auto"`、`"websocket"` 或 `"websocket-cached"`：由 Pi 官方实现处理，扩展不观察 WebSocket 帧；
- 非 SSE 配置在启动时提示额度/用量和远端 Cyber warning 不可靠。

### 后续计划


把 SSE 观察器和未来 WebSocket 观察器都接入同一个：

```ts
SseBodyEventHandler
```

观察器只负责捕获事件，`codex-signals.ts`、`rate-limits.ts` 和 warning/quota
模块继续保持不变。

### 阶段三：增加实验开关

增加显式的实验配置，例如：

```json
{
  "codexWebSocket": "off"
}
```

建议值：

- `off`：强制 SSE，完整功能；
- `on`：使用 WebSocket，但启用扩展观察器；
- `auto`：没有可靠 observer 时自动回退 SSE。

### 阶段四：优先推动 Pi 正式 hook

如果 WebSocket 方案需要长期维护，应提交最小上游改动，让 Pi 在 SSE 和
WebSocket 的 JSON 事件解析点提供统一 callback。正式 hook 可用后，删除全局
WebSocket 包装代码。

## 9. 验收标准

WebSocket 实验模式至少应验证：

- 普通文本响应和工具调用不受影响；
- `response.metadata` 能触发 Cyber warning；
- `codex.response.metadata` 能检测服务器模型；
- `codex.rate_limits` 能更新额度显示；
- 429、额度耗尽和连接错误不会导致观察器吞掉官方错误；
- WebSocket 缓存连接和重连不会重复通知；
- abort、超时和 SSE fallback 正常；
- 观察器抛异常时主响应仍能完成；
- 不输出或保存敏感原始帧；
- SSE 模式的现有测试和行为完全不变。

## 10. 最终建议

在正式 observer hook 尚未进入 Pi 之前：

1. SSE 作为默认和生产方案；
2. WebSocket 只作为实验性 opt-in；
3. 不把全局 WebSocket monkey patch 作为默认行为；
4. 如果必须提供完整 WebSocket 功能，优先做一个小型 Pi 上游 hook，而不是
   维护 fork 或复制 provider。
