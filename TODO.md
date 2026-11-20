# TODO

Note: Anthropic Messages SSE events carry no quota data; the
`anthropic-ratelimit-unified-*` response headers are the only source. No
Anthropic SSE tap or provider wrapper is needed.

- [ ] Publish to npm as `@kcocoa/pi-codex-gateway` (name is free; the pi.dev
  gallery lists npm packages with the `pi-package` keyword). Follow
  `kcocoa/pi-usage-bar` commit `5f17de3`. In `package.json`:
  - remove `"private": true`; add `"keywords": ["pi-package"]`,
    `"license": "MIT"`, and `repository` as an object with
    `git+https://github.com/kcocoa/pi-codex-gateway.git` (npm rewrites the
    string form with a warning);
  - add `"pi": { "extensions": ["./index.ts"] }`. Do not list
    `codex-skills/` there: `index.ts` loads those skills by path, only when
    enabled in config;
  - move `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to
    `peerDependencies` as `"*"`, and add `@earendil-works/pi-tui` there
    (imported by `hosted-image-generation.ts`, undeclared). Keep all three in
    `devDependencies` for `tsc`. Pi supplies them; a bundled copy bypasses
    Pi's module mapping (Pi docs: `packages.md`);
  - `"files": ["*.ts", "!*.test.ts", "providers/", "external-tools/",
    "codex-skills/"]`. This leaves out `experiments/`, `docs/` and
    `TODO.md`; `codex-skills/imagegen/LICENSE.txt` (Apache-2.0) must stay in.
  Check the file list with `npm pack --dry-run`. Add
  `pi install npm:@kcocoa/pi-codex-gateway` to the README install section.
  The user runs `npm publish --access public` in their own terminal: npm 2FA
  needs a browser step that fails inside Pi. npmjs.com may show a
  `0.0.0-stage` placeholder for a few minutes; `npm view <name> version` is
  the real state. Remove this item once published.
- [ ] Attribute WebSocket/SSE body events to a request. `cyber-warning.ts`
  keeps one `activeContext`, set at `turn_start`. Late events from an old
  request can land in a new turn's in-flight window. Fixing it fully needs a
  transport-level hook from Pi (see `docs/websocket.md`). It cannot be tested
  end to end: that needs a real cyber warning, and triggering one risks the
  account.
- [ ] Optional: dispatch observer callbacks via `queueMicrotask` so Pi's own
  listener runs first. Do this after the attribution work, because it delays
  the cyber-warning `ctx.abort()`.
