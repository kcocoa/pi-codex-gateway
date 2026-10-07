# Codex providers extension

User-level [Pi](https://github.com/earendil-works/pi) extension for both Codex
providers:

- `codex-gateway`: API-key provider for standard OpenAI Responses gateways.
- `openai-codex`: augments Pi's built-in ChatGPT OAuth provider.

Shared features include hosted web search, image generation, cyber warnings,
service-tier selection, and quota display.

It also shows a quota usage bar for Pi's built-in `anthropic` provider (see
[Quota display](#quota-display)).

## Provider behavior

### `codex-gateway`

- API: `openai-responses`
- Auth: `/login codex-gateway` or `CODEX_GATEWAY_API_KEY`
- Default base URL: `https://chatgpt.com/v1`
- Models: mirrors Pi's installed `openai-codex` catalog

Override its endpoint in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "codex-gateway": {
      "baseUrl": "https://your-gateway.example.com/v1"
    }
  }
}
```

### `openai-codex`

The extension preserves Pi's built-in model catalog and ChatGPT Plus/Pro OAuth.
It overrides only `streamSimple`, delegates request construction, authentication,
retry, transport, and standard response parsing to Pi's official
`openai-codex-responses` implementation. In SSE mode, a transparent fetch hook
observes optional Codex response-body events while Pi continues to consume the
same response bytes. HTTP response headers are handled by Pi's
`after_provider_response` lifecycle hook. The extension only performs
side-channel observation for quota, model-routing, and Cyber-warning signals.

When the configured transport is not `sse`, the provider can use Pi's WebSocket
transport. WebSocket observation is disabled by default; to enable the
experimental read-only observer, add `"codexWebSocketObserver": true` under
`experimental` in `<Pi agent directory>/codex-gateway.json`. It only observes
text JSON messages from the Codex response socket, does not log raw frames, and
does not support binary messages or exact request-context association. The observer is fail-open and
must not affect Pi's official listener or response handling.

Runtime notes:

- The observer hooks `WebSocket.prototype.send`: a socket is observed from its
  first `send()` after the observer is installed, which also covers
  constructors Pi cached before the extension loaded. Sockets that were
  mid-response when the observer was installed are only observed from their
  next `send()`.
- The observer uninstalls itself when the extension reloads with the option
  disabled: the `send` hook is restored and lingering sockets stop parsing
  messages.
- Cyber-warning `stop` actions only abort a turn when the warning event can be
  attributed to that turn's in-flight response; late or trailing events are
  downgraded to warnings.
- The SSE fallback of the `auto` transport still goes through the fetch-based
  observer; its clone branch stops reading at the terminal response event.

At session startup, the extension explains that quota/usage updates and remote
Cyber warnings are unavailable on WebSocket responses unless this observer is
enabled. Restore the fully supported SSE path with `/settings` → `Transport` →
`SSE`, or set `"transport": "sse"` in `~/.pi/agent/settings.json` (or the project
`.pi/settings.json`). See [docs/websocket.md](docs/websocket.md) for the transport
trade-offs.

### `anthropic`

Only the quota usage bar and `/anthropic:usage` are supported. The extension is
a read-only monitor for this provider: it reads the
`anthropic-ratelimit-unified-*` headers from responses Pi already receives. It
does not change requests, add tools, issue extra requests (so the subscription
plan, e.g. Pro / Max 5x / Max 20x, is not shown), or apply any other feature in
this README to Anthropic models.

## Layout

- `index.ts`: registration and provider-scoped capabilities
- `codex-config.ts`: shared `codex-gateway.json` preference storage
- `codex-provider.ts`: shared provider matching
- `sse-tap.ts`: provider-agnostic SSE response-body observation
- `codex-sse.ts`: Codex terminal-event binding for the SSE tap
- `codex-signals.ts`: server-model and cyber recommendation parsing
- `cyber-warning-policy.ts`: testable warning decisions and deduplication keys
- `cyber-warning.ts`: warning policy integration and persistent setting
- `fast-mode.ts`: persistent `/codex:fast` command
- `rate-limits.ts`: quota header/event parsing
- `quota-display.ts`: footer status and detailed quota command
- `hosted-image-generation.ts`: hosted image SSE reception, metadata parsing, and persistence
- `sse-dump.ts`: opt-in JSONL dump of response headers and parsed stream events for all providers
- `external-tools/`: opt-in local image-generation proxy tools
- `providers/codex-gateway.ts`: API-key gateway provider
- `providers/openai-codex.ts`: official provider transport wrapper and SSE observer
- `docs/websocket.md`: WebSocket implementation plan and known difficulties

## Extension configuration

The extension stores its settings in
`<Pi agent directory>/codex-gateway.json` (normally
`~/.pi/agent/codex-gateway.json`). Supported keys are:

```json
{
  "cyberWarningAction": "warn",
  "serviceTier": "default",
  "experimental": {
    "codexWebSocketObserver": false
  },
  "externalTools": {
    "imageGeneration": false
  }
}
```

- `cyberWarningAction`: `warn` (default), `stop`, or `stop-after-repeat`.
- `serviceTier`: `default` (default) or `priority`.
- `experimental.codexWebSocketObserver`: enables the experimental, read-only
  WebSocket observer; it is disabled by default.
- `externalTools.imageGeneration`: enables the local `image_gen` fallback;
  disabled by default. This is mutually exclusive with the hosted image tool.

The first two options can also be changed with `/codex:cyber` and
`/codex:fast`. Settings not listed above are ignored by this extension.

## Cyber warnings

For active GPT models from either provider, the extension observes:

- `openai-model` / `x-openai-model` values that differ from the requested model;
- `response.metadata` or `codex.response.metadata` containing
  `openai_verification_recommendation: ["trusted_access_for_cyber"]`.

Run `/codex:cyber` to choose:

- `warn` (default): show the warning and continue;
- `stop`: abort the current turn on the first warning;
- `stop-after-repeat`: continue after the first warned turn, then abort the
  second warned turn in the session.

The command also accepts the policy directly, for example
`/codex:cyber stop`. The setting is stored in
`<Pi agent directory>/codex-gateway.json`.

## Fast service tier

Run `/codex:fast` to toggle between `default` and `priority`, or specify the
value directly with `/codex:fast default` or `/codex:fast priority`. Argument
completion lists both options. The setting is stored in
`<Pi agent directory>/codex-gateway.json`.

The extension adds the selected `service_tier` value to the existing Codex
request payload. It does not add a network request or change Pi's cost
calculation. When priority is active for a GPT model, the footer status bar
shows `fast⚡`.

## Quota display

Quota data is parsed from normal response headers and optional SSE
response-body events:

- Codex: `x-<limit>-primary-*` and `x-<limit>-secondary-*`;
  `x-codex-plan-type`, `x-codex-credits-*`, `x-codex-active-limit`, promo,
  and reached-type headers; `codex.rate_limits` SSE body events.
- Anthropic: `anthropic-ratelimit-unified-5h-*` and
  `anthropic-ratelimit-unified-7d-*` (utilization and reset), plus
  `anthropic-ratelimit-unified-status`. These headers are only sent for
  subscription (OAuth) logins, not API keys.

The footer shows remaining percentages and compact reset countdowns, plus the
normalized subscription type for Codex, for example
`pro5x 5h:82%↺3h44m 7d:54%↺5d17h` (Codex) or `5h:97%↺4h47m 7d:77%↺3d20h`
(Anthropic). Reset countdowns contain at most two time units. Observed Codex
plan types are normalized to `plus`, `pro5x`, `pro20x`, `business`, or
`business pro` when recognized.

Run `/codex:usage` or `/anthropic:usage` for all observed limits, absolute
reset times, plan type, credits, and server messages. No separate quota
request is made; the display remains empty until a provider supplies quota
data.

## Hosted web search

For both providers, the extension adds `{ "type": "web_search" }` to the
provider request when no hosted web-search tool is already present.

## Image generation

The default path uses the provider-hosted image-generation tool. For both Codex
providers, the extension injects `{ "type": "image_generation" }` into the
Responses request and receives `image_generation_call` events over SSE. The
receiver persists the result and records the source prompt, requested defaults,
resolved parameters, revised prompt, response ID, and observed event types.

The local `image_gen` proxy is extracted under `external-tools/` and is disabled
by default. Enable it explicitly in `<Pi agent directory>/codex-gateway.json`:

```json
{
  "externalTools": {
    "imageGeneration": true
  }
}
```

When enabled, the original `image_gen` tool and `codex-skills/imagegen/SKILL.md`
are registered as an explicit fallback. It uses the Responses image tool for
`codex-gateway` and the official Codex Images endpoints for `openai-codex`.

This uses a deliberately tricky compatibility shim: Pi registers a flat local
`imagegen` tool, then `before_provider_request` rewrites its model-facing schema
into the reserved `image_gen.imagegen` namespace with Codex's exact wire schema.
The namespace tool and hosted `image_generation` tool are mutually exclusive in
the same request because the provider rejects that combination.

Generated hosted files are saved by default under the current Pi session's
`generated_images/` directory. Ephemeral `--no-session` runs use
`/tmp/generated_images/`. The external proxy also supports explicit
`output_path`, local reference images, and overwrite protection.

For protocol debugging, set `SSE_DUMP_PATH` (legacy `CODEX_SSE_DUMP_PATH` also
works) to an explicit JSONL path. It covers every provider via Pi's
`after_provider_response` and `provider_stream_event` hooks. Each line is
`{ts, kind: "headers" | "event", provider, model, ...}`: HTTP status and
response headers (auth and cookie headers redacted), or a parsed stream event
as Pi sees it before normalization (not the raw SSE frame). The dump can include sensitive prompts, reasoning
metadata, and base64 image data; keep it disabled during normal use.

## License

MIT — see [LICENSE](LICENSE). The vendored `codex-skills/imagegen/` skill is
OpenAI's and keeps its own Apache-2.0 [license](codex-skills/imagegen/LICENSE.txt).
