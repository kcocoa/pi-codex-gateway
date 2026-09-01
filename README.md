# Codex providers extension

User-level [Pi](https://github.com/earendil-works/pi) extension for both Codex
providers:

- `codex-gateway`: API-key provider for standard OpenAI Responses gateways.
- `openai-codex`: augments Pi's built-in ChatGPT OAuth provider.

Shared features include hosted web search, image generation, cyber warnings,
service-tier selection, and quota display.

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
It overrides only `streamSimple`, delegates request construction and response
parsing to Pi's official `openai-codex-responses` implementation, and forces SSE
so the extension can observe optional raw Codex stream events and HTTP response
headers through Pi's supported `fetch` injection and provider hooks. The SSE body
is passed through unchanged; the extension only performs a side-channel
observation for quota, model-routing, and Cyber-warning signals.

SSE is forced intentionally. Pi currently does not expose an equivalent public
hook for raw WebSocket frames, so enabling WebSocket would require unsupported
runtime interception or a local proxy and could make those optional features
unreliable. See [docs/websocket.md](docs/websocket.md) for the WebSocket design,
trade-offs, and implementation plan. This disables the provider's WebSocket
transport while the extension is loaded.

## Layout

- `index.ts`: registration and provider-scoped capabilities
- `codex-config.ts`: shared `codex.json` preference storage
- `codex-provider.ts`: shared provider matching
- `codex-sse.ts`: transparent observation of optional SSE events
- `codex-signals.ts`: server-model and cyber recommendation parsing
- `cyber-warning.ts`: warning policy and persistent setting
- `fast-mode.ts`: persistent `/codex:fast` command
- `rate-limits.ts`: quota header/event parsing
- `quota-display.ts`: footer status and detailed quota command
- `image-generation.ts`: provider-native image generation and persistence
- `providers/codex-gateway.ts`: API-key gateway provider
- `providers/openai-codex.ts`: official provider SSE observer
- `docs/websocket.md`: WebSocket implementation plan and known difficulties

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
`<Pi agent directory>/codex.json`.

## Fast service tier

Run `/codex:fast` to toggle between `default` and `priority`, or specify the
value directly with `/codex:fast default` or `/codex:fast priority`. Argument
completion lists both options. The setting is stored in
`<Pi agent directory>/codex.json`.

The extension adds the selected `service_tier` value to the existing Codex
request payload. It does not add a network request or change Pi's cost
calculation. When priority is active for a GPT model, the footer status bar
shows `fast⚡`.

## Quota display

For either provider, quota data is parsed from normal response headers and
optional stream events:

- `x-<limit>-primary-*` and `x-<limit>-secondary-*`;
- `x-codex-plan-type`, `x-codex-credits-*`, `x-codex-active-limit`, promo,
  and reached-type headers;
- `codex.rate_limits` events.

The footer shows the normalized subscription type, remaining percentages, and
compact reset countdowns, for example
`pro5x 5h:82%↺3h44m 7d:54%↺5d17h`. Reset countdowns contain at most two time
units. Observed plan types are normalized to `plus`, `pro5x`, `pro20x`,
`business`, or `business pro` when recognized.

Run `/codex:usage` for all observed limits, absolute reset times, plan type,
credits, and server messages. No separate quota request is made; the display
remains empty until a provider supplies quota data.

## Hosted web search

For both providers, the extension adds `{ "type": "web_search" }` to the
provider request when no hosted web-search tool is already present.

## Image generation

For active GPT models from either provider, the extension discovers
`codex-skills/imagegen/SKILL.md` and activates the `image_gen` tool.

- `codex-gateway` uses the Responses API hosted `image_generation` tool.
- `openai-codex` uses the official Codex Images endpoints with the existing OAuth
  token and `gpt-image-2`. It supports generation and edits with up to five input
  images and currently returns PNG output only.

Generated files are saved by default under the current Pi session's
`generated_images/` directory. Ephemeral `--no-session` runs use
`/tmp/generated_images/`. Set `output_path` when the asset belongs in the
project. Existing files are not overwritten unless `overwrite: true` is given.

The Skill is discovered at startup or `/reload`; after switching to or from a
supported provider, run `/reload` to refresh the available Skill list.

## License

MIT — see [LICENSE](LICENSE). The vendored `codex-skills/imagegen/` skill is
OpenAI's and keeps its own Apache-2.0 [license](codex-skills/imagegen/LICENSE.txt).
