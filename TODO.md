# TODO

Note: Anthropic Messages SSE events carry no quota data; the
`anthropic-ratelimit-unified-*` response headers are the only source. No
Anthropic SSE tap or provider wrapper is needed.

- [ ] Check the Bun constructor-cache note is still true. The observer now hooks
  `WebSocket.prototype.send` instead of replacing the constructor, so it may
  no longer matter. If so, drop the note from the `session_start` notify in
  `index.ts:118` and from the README. Test on both Bun and Node.
- [ ] Attribute WebSocket/SSE body events to a request. `cyber-warning.ts` and
  `quota-display.ts` each keep one `activeContext`, set at `turn_start`. Late
  events from an old request can land in a new turn's in-flight window. Fixing
  it fully needs a transport-level hook from Pi (see `docs/websocket.md`).
- [ ] Optional: dispatch observer callbacks via `queueMicrotask` so Pi's own
  listener runs first. Do this after the attribution work, because it delays
  the cyber-warning `ctx.abort()`.
- [ ] Fix tsc errors that were already there: `fast-mode.ts`,
  `experiments/official-hooks-probe.ts`, and the missing `bun` types
  (`tsconfig.json`).
