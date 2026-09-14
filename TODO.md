# TODO：扩展生命周期与传输观察问题（已核实版）

> 运行时要求：Bun 和 Node.js 都必须支持。
>
> 本文件已逐项对照扩展源码、Pi 的 `packages/ai/dist/api/openai-codex-responses.js`
> 以及 `docs/extensions.md` 的生命周期文档核实。每项给出：结论、根因、方案。

## 核实结论总览

| # | 原问题 | 结论 |
|---|--------|------|
| 1 | WebSocket 全局修改在重载后残留 | ✅ 真实存在 |
| 2 | 新生命周期与旧全局状态耦合 | ✅ 真实存在（与 #1 同根因，应合并处理） |
| 3 | observer 在 Pi listener 之前同步执行 | ✅ 真实存在（严重度：低～中） |
| 4 | WebSocket 消息没有请求/turn 归属 | ✅ 真实存在 |
| 5 | observer 可能主动终止错误请求 | ✅ 真实存在（是 #4 的直接后果） |
| 6 | `auto` 回退 SSE 后 fetch observer 仍介入 | ⚠️ 部分成立：介入为真，"请求直到超时才结束"不成立，需修正 |
| 7 | Node.js 与 Bun 运行时差异 | ✅ 真实存在，且确认一个 Bun 特有 bug 场景 |

---

## 先排除的场景：`/reload` 时正在生成的请求

**核实：成立，可保留。**

Pi 文档（`docs/extensions.md`）确认 `/reload` 流程为：旧扩展实例收到
`session_shutdown` → 终止当前 turn → 重新加载扩展 → `session_start(reason: "reload")`。
旧实例的 `session_shutdown` 先于新实例加载执行（这同时说明 #2 里"新旧回调同时
处理同一消息"在正常 reload 顺序下不会发生——旧回调先删、新回调后加）。

因此：重载时正在输出的请求不是有效业务前提；需要关注的是残留全局状态与
归属错误，见下文各项。

---

## 1.（原 #1 + #2 合并）WebSocket 全局修改残留与跨生命周期共享状态

两问同根因，合并处理。

### 核实：真实存在

`codex-websocket.ts` 中：

- `installCodexWebSocketObserver` 把 `globalThis.WebSocket` 替换为 Proxy，
  状态存在 `Symbol.for("pi-codex-gateway.websocket-observer")`；
- 返回的 cleanup 只做 `state.observers.delete(onEvent)`；
- **从不恢复** `globalThis.WebSocket`，**从不删除** `Symbol.for` 状态，
  **从不移除**装在已构造 socket 上的 `message` listener。

具体后果（按原清单的边界场景核实）：

| 场景 | 实际行为 |
|------|----------|
| 开启 → reload → 关闭 | Proxy 永久残留；每个 Codex socket 仍走 Proxy，listener 仍对每条消息做 `JSON.parse`，dispatch 到空集合（纯开销，无功能）。 |
| 开启 → reload → 开启 | 新实例向旧 Proxy 的共享 state 添加回调，功能上"碰巧"正常（见 #7：Bun 下这甚至是必要的）。 |
| 多次 reload | 状态持续累积，无泄漏但永不归零。 |
| 已缓存连接复用 | Pi 的 `websocketSessionCache`（空闲 5 分钟 / 最长 55 分钟存活）里的 socket 是经 Proxy 构造的，其上的旧 listener 一直存活并继续解析消息。 |

原 #2 中"同一消息被多个回调处理"在正常 reload 顺序下**不成立**（见上文排除场景），
仅当旧实例的 `session_shutdown` 未执行（异常退出）时才可能出现，属于防御性问题。

### 根因

清理函数是"注销回调"而不是"卸载安装"。安装是全局副作用，卸载必须与之对称。

### 方案：引用计数式安装/卸载

1. `ObserverState` 增加 `original: typeof WebSocket`（被替换前的构造函数）和
   `disposed: boolean`；
2. cleanup 时删除回调，若删除后 `observers.size === 0`：
   - 置 `state.disposed = true`；
   - 恢复 `globalThis.WebSocket = state.original`；
   - 删除 `globalThis[INSTALL_KEY]`；
3. construct trap 和 message listener 开头检查 `state.disposed`：
   - disposed 后 construct trap 直接 `Reflect.construct(target, args, newTarget)`
     返回裸 socket，不再挂 listener；
   - 已有 socket 上的旧 listener 读到 disposed 后直接 return，
     消除每消息 `JSON.parse` 开销（闭包持有 `state` 引用即可，无需真的
     removeEventListener）；
4. Bun 注意（见 #7）：Pi 模块级缓存 `_cachedWebsocket` 的子类永远 extends 旧
   Proxy；disposed 后旧 Proxy 的 construct trap 走"裸透传"分支，行为正确。

测试矩阵：开启→reload→关闭 / 开启→reload→开启 / 多次 reload / Bun 与 Node 分别跑。

---

## 2.（原 #3）observer 在 Pi 官方 listener 之前同步执行

### 核实：真实存在，严重度低～中

对照 Pi 源码确认执行顺序：

- 扩展的 message listener 在 Proxy construct trap 中于**构造时**注册；
- Pi 自己的 listener 在 `processWebSocketStream → parseWebSocket` 中、
  `socket.send()` 之前才注册。

同一 `message` 事件按注册顺序触发 → 扩展回调链先于 Pi listener 同步执行。链路
与原清单一致：`JSON.parse → dumpSseEvent → cyberWarnings → quotaDisplay →
hostedImages → Pi listener`。

影响核实：

- `dispatch` 对每个 observer 有 try/catch，异常不会传给 Pi —— 同步**异常**无影响；
- 同步**耗时**真实存在：正常路径是微秒级；`CODEX_SSE_DUMP_PATH` 开启时
  `dumpSseEvent` 用 `appendFileSync` **每条消息同步写盘**，这是唯一实际可感的
  阻塞点。

### 方案

1. `dumpSseEvent` 改为异步缓冲写（内存队列 + 周期性/批量 `fs.appendFile`），
   这一条收益最大、风险最小，优先做；
2. 可选：dispatch 改为 `queueMicrotask` 延迟，让 Pi listener 先行。注意这会推迟
   cyber-warning 的 `ctx.abort()` 时序（abort 发生在 Pi 处理该消息之后）——通常
   更安全，但需要在 #4 的归属修复之后再做，避免晚到的 abort 打到新 turn。

---

## 3.（原 #4）WebSocket 消息没有请求/turn 归属

### 核实：真实存在

- `index.ts` 的 `handleBodyEvent(event)` 无任何上下文参数；
- `cyber-warning.ts` 与 `quota-display.ts` 各自维护**单一** `activeContext`，
  仅在 `turn_start` 时赋值；
- `hosted-image-generation.ts` 已部分按 `response.id` 归属（`activeResponseId`
  + `requests` Map），但 `activeResponseId` 也是单槽位。

错配来源全部核实为真：

- Pi 的 `websocket-cached` / `auto` 会在同一 session 内**复用连接**跨请求；
- SSE clone 分支（见 #5）在 Pi 收尾后仍会 dispatch 尾随事件；
- 旧连接晚到的 `metadata`、多 socket 并存、多 session 共进程。

后果：quota/模型提示/图片状态可能被错误请求的事件更新；cyber warning 触发
`ctx.abort()` 时终止的是**当前** active turn 而非产生该消息的请求（见 #4）。

### 方案（按性价比排序）

1. **abort 守卫（最优先，防错杀）**：cyber-warning 的 stop 动作仅在事件携带
   `response.id` 且与当前 turn 的 response 匹配，或事件确实是本 turn 首个
   `response.created` 时才执行；否则降级为 warn。这一条独立于完整归属修复，
   可先行落地。
2. **事件过期判定**：在 `after_provider_response` / turn 收尾时递增一个 turn
   序号，`handleBodyEvent` 拒绝处理"上一 turn 开始前已排队"的事件（对 SSE
   clone 尾随事件尤其有效）。
3. **传递来源**：`SseBodyEventHandler` 增加第二参数（`"ws" | "sse"`），供诊断
   与后续按 socket 归属扩展。完整按 socket/request 归属需要 Pi 暴露请求侧
   钩子，超出本扩展能力，保持 best-effort 并在 notify 文案中如实声明（现有
   文案已声明"exact request context are unsupported"，保留）。

---

## 4.（原 #5）observer 主动终止请求（#3 的后果）

### 核实：真实存在

`cyber-warning.ts` 的 `notifyWarning` 在 `shouldStop` 且 `!ctx.isIdle()` 时执行
`ctx.abort()`。归属错误时 abort 错误 turn：真实。

"远端都表现为 `CLIENT_ABORTED`、服务端日志无法区分取消来源"：成立，但这是
服务端可观测性问题，客户端无法改变；本地来源区分其实已经具备
（`abortingCurrentTurn` 标记 + notify 文案 "Stopping the current turn..."）。

### 方案

核心修复同 #3 方案 1（abort 守卫）。补充：abort 时在 `dumpSseEvent`/诊断输出
中写入 `source: "cyber-abort"` 标记，便于本地事后区分用户取消 / 生命周期取消 /
扩展取消。无需再单列清单项。

---

## 5.（原 #6）`auto` 回退 SSE 后 fetch observer 仍介入 —— 症状需修正

### 核实：介入为真；"请求直到超时才被判定结束"**不成立**

为真的部分：

- `providers/openai-codex.ts` 注入的 tapped fetch 会覆盖 `options.fetch`；
- Pi 的 `stream()` 在 WebSocket **开始输出前**失败（`websocketStarted === false`）
  时 `recordWebSocketSseFallback` → break → SSE 路径使用 `options?.fetch ?? globalThis.fetch`，
  即扩展的 tapped fetch；
- `createSseEventTapFetch` 对 SSE `Response` 执行 `response.clone()`，
  clone 分支在后台独立读取：一个响应、两个读取分支，属实。

**不成立的部分（原文应删除）**：

- "Pi 在解析器收尾时等待 reader 的取消或关闭；请求直到超时才被判定结束"——
  查 Pi 的 `parseSSE` finally 块：`await reader.cancel()` 只 cancel **原始**分支；
  ReadableStream tee 语义下取消一个分支**立即 resolve**，不等待另一分支；
  turn 的完成（`stream.push({type:"done"})` + `stream.end()`）完全不等待
  clone 分支。无任何代码路径会因 clone 分支挂起而判请求超时。
- 用户 abort 时，abort signal 直接作用于 fetch，body 出错会让 clone 分支的
  `reader.read()` reject 并被 catch 退出，无泄漏。

真实的残留风险（并入 #3 处理）：

1. clone 分支在 Pi 已收尾后继续 dispatch 尾随事件 → 跨 turn 错配
   （这正是 #3 方案 2"事件过期判定"要解决的）；
2. Pi cancel 原始 reader 后，tee 为 clone 分支继续拉流，连接多活一小段时间
   （服务端结束流后即终止），属轻微开销。

### 方案（已实施，含语义核实）

- 删除"挂起直到超时"结论；
- clone 分支收到 `response.completed` / `[DONE]` 后主动 `reader.cancel()`，
  尽早结束观察分支；
- 尾随事件归属问题按 #3 方案 2 处理。

#### 关于 `reader.cancel()` 的影响范围（已核实）

`response.clone()` 内部是 tee（分流）。按 ReadableStream tee 规范，取消
**其中一条分支**：源（网络连接）不取消、立即 resolve；tee 继续为未
取消的分支（Pi 的原始分支）拉取/缓冲；只有**两条分支都取消**时源才被
取消——而那个时点由 Pi 自己的 `reader.cancel()` 决定（Pi 解析器在同一
终止事件处停止，与无观察者基线完全一致）。

因此该 cancel 只影响观察分支本身，不越俎代庖；相反，**不取消**才会让
连接比基线多活（tee 为观察分支继续拉流）。已在 Bun 与 Node 分别用
"观察分支自取消后：源未取消、原始分支仍可读完全部 chunk、仅在原始分支
取消后源才取消"的探针测试实证（`codex-sse.test.ts` 的
 "cancelling the clone branch leaves the provider branch untouched"）。

---

## 6.（原 #7）Node.js 与 Bun 运行时差异 —— 确认一个 Bun 特有 bug 场景

### 核实结果逐条

| 原疑问 | 结论 |
|--------|------|
| Proxy 是否保留构造参数 | ✅ 是。`Reflect.construct(target, args, newTarget)` 参数原样透传，newTarget 保持，两运行时实例行为均正确（`instanceof`、prototype 均正常）。 |
| Pi 传入 `{ headers }` 是否原样传递 | ✅ 透传。Node 下 undici WebSocket 如何处理 headers 选项是 **Pi 自身行为**，与扩展 Proxy 无关，扩展不改变它。 |
| Pi 是否缓存 WebSocket 构造函数 | ⚠️ **分运行时**：Bun 下 `getWebSocketConstructor` 有模块级缓存 `_cachedWebsocket`（首次调用把当时的 `globalThis.WebSocket` 固化为超类，之后不再更新）；Node 下每次调用重新读取 `globalThis.WebSocket`。 |
| 重载后缓存构造函数是否仍引用旧 wrapper | ⚠️ Bun 下是。这造成一个**已确认的 bug 场景**：observer 先关闭（或从未开启）→ 已发生过 WS 连接（Bun 缓存已固化原始构造函数）→ reload 后开启 observer → 新 Proxy 在 Bun 下被**完全绕过**，observer 静默失效。Node 下无此问题。另：`Symbol.for` 共享状态使"开启→reload→开启"在 Bun 下反而正常（缓存子类 extends 的旧 Proxy 正是共享 state 的那个）。 |
| message 事件数据是否都是字符串 | ✅ 文本帧在两运行时均为 string。扩展 `parseMessage` 只接受 string，二进制帧被静默丢弃——已在 notify 文案中如实声明（"binary messages … unsupported"），属已知限制。 |

### 方案

1. Proxy 透明性无需修改；
2. Bun 的 `_cachedWebsocket` 缓存是 Pi 内部模块状态，扩展无法从外部失效它。
   务实做法：文档 + 代码注释注明 **"observer 配置从关到开的切换在 Bun 下需要
   重启进程才生效（Pi 的构造函数缓存所致）"**，并在 `session_start` 的 observer
   notify 中检测该情形给出提示（可用一个一次性探针 socket 或直接文案提示）；
3. #1 的引用计数卸载方案已覆盖 Bun 缓存与新 Proxy 的交互（disposed 后旧
   Proxy 走裸透传分支）。

---

## 实施顺序建议（含实施状态）

1. ✅ **#1 引用计数卸载**（已实施：`codex-websocket.ts`）——state 增加
   `version`/`wrapped`/`original`/`disposed`；最后一个 observer 注销时恢复
   全局构造函数并删除共享状态；旧 Proxy 对后续构造退化为纯透传，已装
   listener 读到 `disposed` 后直接返回，消除逐消息 `JSON.parse` 开销；
   版本号防止复用旧版本模块留下的不兼容共享状态（旧包装器只会被链式
   包裹，不会被覆写）。测试：`codex-websocket.test.ts` 新增 lifecycle
   describe（保持安装/恢复、卸载后透传、重装）。
2. ✅ **#4 abort 守卫**（已实施：`cyber-warning.ts`）——跟踪当前 turn 的
   response 生命周期（`response.created`/`in_progress` → 在飞，
   `response.completed`/`done`/`incomplete`/`failed`/`error` → 结束）；
   body 事件仅在响应在飞时可归属，否则降级为 warn（不计入
   stop-after-repeat、不 abort）；`after_provider_response` headers 路径
   始终视为已归属（由 Pi 提供真实 ctx）。测试：`cyber-warning.test.ts`。
3. ✅ **#2 方案 1：dump 异步化**（已实施：`sse-dump.ts`）——内存缓冲 +
   250ms 批量异步 `appendFile`，10k 行封顶的 debug 限流；导出
   `flushSseDump()` 供测试/检查。测试：`sse-dump.test.ts`。
4. ✅ **#5：clone 分支提前 cancel**（已实施：`codex-sse.ts`）——观察分支
   收到终止事件（与 Pi 解析器相同的终止类型）后主动 `reader.cancel()`，
   尾随事件不再进入下一 turn；测试：`codex-sse.test.ts` 新增用例。
5. ✅ **#6：Bun 缓存限制文档与提示**（已实施）——`index.ts` 的
   `session_start` notify 及 README 增加说明：Bun 下开关切换仅在本进程
   尚未建立 Codex WebSocket 连接时生效，否则需重启 pi。
6. ⬜ 可选：dispatch 延迟化（`queueMicrotask` 让 Pi listener 先行）——
   依赖归属修复完成后的时序评估，暂缓。

### 归属问题的剩余已知限制

- body 事件多不携带 response id（实测 dump：仅
  `response.created/in_progress/completed` 携带 `response.id`，delta 类
  事件均无 id），因此无法做到完全精确归属；已实施的“响应在飞”窗口判定
  覆盖了已识别的错杀场景（空闲期晚到事件、终止后续尾随事件），
  “旧请求未完成响应的晚到事件落入新 turn 在飞窗口”仍是理论盲区，需
  Pi 暴露传输层 hook 才能根除（见 docs/websocket.md §4）。

### 附带修复（非 TODO 清单项）

- `quota-display.test.ts`：改用 `mock.module` + 动态 import（bun test 不
  解析 `@earendil-works/pi-coding-agent`，该文件在 HEAD 上即无法运行）；
  修复了 mock 函数类型推导导致的 tsc 错误。
- `codex-sse.test.ts`：修正 `as typeof globalThis.fetch` 双重断言写法。
- 遗留（HEAD 上即存在，未处理）：`fast-mode.ts` 与
  `experiments/official-hooks-probe.ts` 各自的 tsc 错误。
