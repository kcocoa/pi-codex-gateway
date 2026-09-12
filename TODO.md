# TODO：增加最小 WebSocket message observer

状态：待实现。默认关闭。

## 目标

在不修改 Pi 官方 WebSocket provider 的前提下，旁路读取 Codex WebSocket 的 JSON
message，复用现有的 `handleBodyEvent()`：

```text
Pi WebSocket
  ├─ Pi 官方 message listener
  └─ 扩展只读 observer
```

扩展不能影响官方 listener、响应流、错误处理、重试或 SSE fallback。

## 已确认事实

基于本机当前的 `@earendil-works/pi-ai@0.85.1`：

- 扩展当前只包装 `fetch`，所以只能观察 SSE；
- `fetch` 不影响 WebSocket transport；
- Pi 使用 `new WebSocketCtor(url, { headers: wsHeaders })`；
- `WebSocketCtor` 来自 `globalThis.WebSocket`；
- Pi 自己监听 socket 的 `message`；
- Pi 将 WebSocket message 解码后直接 `JSON.parse`，不是 SSE；
- `auto` 和 `websocket-cached` 可能复用 socket。

实际源码：

```text
/home/bkjzon/.pi/agent/npm/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js
/home/bkjzon/.pi/agent/npm/node_modules/@earendil-works/pi-ai/dist/types.d.ts
```

实现前重新确认实际运行时加载的包版本和路径。

## 第一版只做这些

1. 用 `Proxy` 包装 `globalThis.WebSocket`；
2. 保留原始 constructor 的 URL、第二参数和 `newTarget`；
3. 只匹配 Codex WebSocket URL；
4. 创建 socket 后增加一个 `message` listener；
5. 文本 JSON 解析成功后调用现有 `handleBodyEvent()`。

## 第一版明确不做这些

- 不复制或修改 Pi provider；
- 不 patch `EventTarget.prototype`；
- 不包装 `socket.send()`；
- 不实现 request/session/response 映射；
- 不使用 `AsyncLocalStorage`；
- 不处理 WebSocket retry、fallback、Upgrade headers；
- 不增加复杂队列、超时、统计或持久化；
- 不处理二进制 message；
- 不建立 Node/Bun 全版本测试矩阵；
- 不新增 WebSocket 专用 quota/Cyber/image 业务模块。

因此第一版使用现有的活动 Codex turn 状态。无法关联活动 context 时，只忽略业务
副作用，不调用错误 context 的 `abort()`。

---

## 实现方案

### 1. 新增 `codex-websocket.ts`

文件只负责：

- 安装一次 wrapper；
- 过滤 URL；
- 解析文本 message；
- fail-open 分发事件。

核心形状：

```ts
const CODEX_PATH = "/codex/responses";
const state = { observers: new Set<SseBodyEventHandler>() };

const WrappedWebSocket = new Proxy(OriginalWebSocket, {
  construct(target, args, newTarget) {
    const socket = Reflect.construct(target, args, newTarget) as WebSocket;

    if (!isCodexUrl(args[0])) return socket;

    socket.addEventListener("message", (message) => {
      try {
        if (typeof message.data !== "string") return;
        const value = JSON.parse(message.data) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;

        for (const observer of state.observers) {
          try {
            observer(value as Record<string, unknown>);
          } catch {
            // Observer failure must not affect Pi.
          }
        }
      } catch {
        // Invalid or unsupported observer data is ignored.
      }
    });

    return socket;
  },
});
```

实际实现需要根据 TypeScript/Bun 类型调整 constructor 参数类型，但不要扩展成
第二套 WebSocket 实现。

### 2. 安装和卸载

在 `index.ts` 的 extension factory 中，建立 `handleBodyEvent` 后、注册 provider
前安装：

```ts
const cleanup = config.codexWebSocketObserver === true
  ? installCodexWebSocketObserver(handleBodyEvent)
  : () => {};
```

注册：

```ts
pi.on("session_shutdown", () => cleanup());
```

安装器必须幂等，避免 `/reload` 后重复通知。可以让 wrapper 保留在进程中，只移除
当前 observer；不需要实现复杂的 wrapper 恢复机制。

配置使用现有 `codex.json`：

```json
{
  "codexWebSocketObserver": true
}
```

缺省为关闭，不改变 Pi 的 `transport` 设置。

### 3. 复用现有 fan-out

不新增 WebSocket 业务处理函数，直接复用：

```ts
const handleBodyEvent = (event: Record<string, unknown>): void => {
  dumpSseEvent(event);
  cyberWarnings.handleBodyEvent(event);
  quotaDisplay.handleBodyEvent(event);
  hostedImages.handleBodyEvent(event);
};
```

第一版不增加 `transport` 元数据，不修改现有业务模块接口。

### 4. 安全边界

observer 必须：

- 不修改 `event.data`；
- 不调用 `preventDefault()`、`stopPropagation()` 或 `stopImmediatePropagation()`；
- 不调用 `socket.close()`；
- 不记录完整 WebSocket frame；
- 不记录 prompt、tool 参数、Authorization、Cookie 或 token；
- 不因解析失败影响 Pi 官方 stream。

二进制 message 第一版直接忽略。如果实际服务确认使用二进制，再单独增加 decoder，
不要提前加入 Blob 队列和超时系统。

---

## 最小测试

新增 `codex-websocket.test.ts`，只覆盖以下 5 项：

1. **构造参数转发**：fake WebSocket 收到原始 URL 和 `{ headers }`。
2. **JSON message**：触发一条文本 JSON，observer 收到相同对象。
3. **官方 listener 共存**：官方 fake listener 和扩展 listener 都被调用。
4. **fail-open**：observer 抛异常，官方 listener 仍执行，socket 未关闭。
5. **URL 过滤与幂等**：非 Codex URL 不观察；重复安装同一 handler 不重复通知。

不测试：

- 真实网络；
- OAuth；
- quota 数值；
- 图片完整数据；
- reconnect/fallback 状态机；
- 并发 session；
- 所有 Node/Bun 版本；
- Pi 内部 provider 的重复测试。

这些测试足以证明“能够旁路监听且不破坏官方 socket”。不要为了覆盖假设中的
未来问题扩大第一版测试范围。

---

## 验收标准

- [ ] SSE 现有测试全部通过；
- [ ] observer 默认关闭；
- [ ] Codex 文本 JSON message 可以被观察；
- [ ] Pi 官方 listener 和回答流不受影响；
- [ ] observer 异常不会破坏回答；
- [ ] 非 Codex socket 不被观察；
- [ ] `/reload` 不产生重复通知；
- [ ] 不输出敏感原始帧；
- [ ] README 说明 WebSocket observer 是实验功能，暂不支持二进制 message 和
      精确 request context 关联。

如果无法证明“官方 listener 不受影响”，停止实现，不增加其他功能。

## 后续工作（不属于本 TODO 的第一版）

只有第一版稳定后，才分别考虑：

- 二进制 message decoder；
- request/session scope；
- 精确 Cyber warning context；
- transport metadata；
- Pi 正式 observer hook。
