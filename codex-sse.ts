/**
 * Codex / OpenAI Responses binding for the generic SSE body tap.
 *
 * Transport-level observation lives in `sse-tap.ts`; this module only adds the
 * Codex-specific terminal event set. Other providers reuse `sse-tap.ts`
 * directly and pass their own terminal events, so they never inherit Codex
 * semantics.
 */
import {
	type SseBodyEventHandler,
	withSseBodyEventTap,
} from "./sse-tap.ts";

export type {
	SseBodyEvent,
	SseBodyEventHandler,
	SseTapOptions,
} from "./sse-tap.ts";

// Events that end a Codex response, matching Pi's own stream parser
// (mapCodexEvents stops processing at the same types).
export const CODEX_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
	"response.completed",
	"response.done",
	"response.incomplete",
]);

/** Attach the generic SSE tap with Codex terminal-event semantics. */
export function withCodexSseBodyEventTap<
	T extends { fetch?: typeof globalThis.fetch },
>(
	options: T | undefined,
	onEvent: SseBodyEventHandler,
): T & { fetch: typeof globalThis.fetch } {
	return withSseBodyEventTap(options, onEvent, {
		terminalEventTypes: CODEX_TERMINAL_EVENT_TYPES,
	});
}
