# Codex Gateway provider

User-level pi extension registering the `codex-gateway` provider:

- Provider: `codex-gateway`
- API: `openai-responses` (built-in standard Responses API, REST + SSE — no custom API code)
- Auth: built-in `envApiKeyAuth` (stored credential via `/login` or `CODEX_GATEWAY_API_KEY` env)
- Model catalog: mirrors the installed pi `openai-codex` catalog (auto-synced on pi updates, no manual maintenance)
- Default base URL: `https://chatgpt.com/v1` (official). To use a gateway/proxy, override via `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "codex-gateway": {
      "baseUrl": "https://your-gateway.example.com/v1"
    }
  }
}
```

## Why this extension

The built-in `openai-codex` provider is hardwired to ChatGPT account OAuth + WebSocket transport (`chatgpt.com/backend-api`). For API-key based gateways that speak the standard Responses protocol over SSE, this extension registers a provider that:

- Mirrors the official codex model catalog automatically (`getBuiltinModels("openai-codex")`)
- Uses the built-in `openai-responses` API implementation (no self-written streaming code)
- Authenticates with a Bearer API key

## Layout

- `index.ts`: provider registration, provider-scoped Skill discovery, and tool activation
- `image-generation.ts`: native Responses `image_generation` tool wrapper and session-scoped output persistence
- `providers/codex-gateway.ts`: provider composition (built-in API + auth)
- `providers/codex-gateway.models.ts`: mirror of the openai-codex catalog (api → `openai-responses`)

Normal chat streaming uses the built-in `@earendil-works/pi-ai` Responses implementation.
`image-generation.ts` makes a separate non-streaming Responses request only when Pi's
`image_gen` tool is called, because Pi's standard Responses stream parser does not expose
hosted image-generation results as a Pi tool result.

## Authentication

Use either `/login codex-gateway` (stored in `auth.json`) or an environment variable:

```bash
export CODEX_GATEWAY_API_KEY="your-key"
```

The provider converts the API key to `Authorization: Bearer <key>`.

## Model catalog notes

The mirror maps every built-in codex model to the `openai-responses` API. Costs, context windows, thinking level maps, and `compat` flags (`supportsToolSearch`, `supportsOpenAIGrammarTools`, ...) are inherited unchanged from the official pi catalog.

## Native image generation

For active `codex-gateway` GPT models, this extension also:

- discovers `codex-skills/imagegen/SKILL.md` as the provider-scoped `/skill:imagegen` Skill;
- activates an `image_gen` Pi tool that calls the model's native Responses API
  `image_generation` hosted tool (not the bundled Python CLI);
- writes results by default to
  `<Pi session directory>/generated_images/`, typically
  `~/.pi/agent/sessions/--<encoded-cwd>--/generated_images/`; for `--no-session`
  runs, `/tmp/generated_images/`;
- accepts `image_paths` for local editing/reference inputs and returns the generated
  image as Pi tool output for inline display and follow-up edits.

Use `output_path` only when the requested asset belongs in the project. The tool avoids
overwriting an existing file unless `overwrite: true` is explicitly passed. The Skill is
discovered only at startup or `/reload`; after switching to or from this provider, run
`/reload` to refresh its available-Skill list.
