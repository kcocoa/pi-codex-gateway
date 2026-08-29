# Codex providers extension

User-level Pi extension for both Codex providers:

- `codex-gateway`: API-key provider for standard OpenAI Responses gateways.
- `openai-codex`: augments Pi's built-in ChatGPT OAuth provider.

Shared features include hosted web search, image generation, cyber warnings, and
quota display.

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
It overrides only `streamSimple`, delegates to Pi's official
`openai-codex-responses` implementation, and forces SSE so optional raw Codex
metadata can be observed. This disables the provider's WebSocket transport while
the extension is loaded.

## Layout

- `index.ts`: registration and provider-scoped capabilities
- `codex-provider.ts`: shared provider matching
- `codex-sse.ts`: transparent observation of optional SSE events
- `codex-signals.ts`: server-model and cyber recommendation parsing
- `cyber-warning.ts`: warning policy and persistent setting
- `rate-limits.ts`: quota header/event parsing
- `quota-display.ts`: footer status and detailed quota command
- `image-generation.ts`: provider-native image generation and persistence
- `providers/codex-gateway.ts`: API-key gateway provider
- `providers/openai-codex.ts`: official provider SSE observer

## Cyber warnings

For active GPT models from either provider, the extension observes:

- `openai-model` / `x-openai-model` values that differ from the requested model;
- `response.metadata` or `codex.response.metadata` containing
  `openai_verification_recommendation: ["trusted_access_for_cyber"]`.

Run `/codex:settings` to choose:

- `warn` (default): show the warning and continue;
- `stop`: abort the current turn on the first warning;
- `stop-after-repeat`: continue after the first warned turn, then abort the
  second warned turn in the session.

The command also accepts the policy directly, for example
`/codex:settings stop`. The setting is stored in
`<Pi agent directory>/codex.json`.

## Quota display

For either provider, quota data is parsed from normal response headers and
optional stream events:

- `x-<limit>-primary-*` and `x-<limit>-secondary-*`;
- `x-codex-credits-*`, `x-codex-active-limit`, promo, and reached-type headers;
- `codex.rate_limits` events.

The footer shows remaining percentages such as `5h:82% 7d:54%`. Run
`/codex:usage` for all observed limits, reset times, plan type, credits, and
server messages. No separate quota request is made; the display remains empty
until a provider supplies quota data.

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
