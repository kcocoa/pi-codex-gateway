import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FLUSH_INTERVAL_MS = 250;
// Debug-only backpressure: drop new events instead of growing unbounded if
// the sink cannot keep up.
const MAX_PENDING_LINES = 10_000;

let queuedPath: string | undefined;
let initializedPath: string | undefined;
let pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;

async function flush(): Promise<void> {
	if (flushing || queuedPath === undefined || pendingLines.length === 0) return;
	flushing = true;
	const path = queuedPath;
	const lines = pendingLines.join("");
	pendingLines = [];
	try {
		if (initializedPath !== path) {
			await mkdir(dirname(path), { recursive: true });
			initializedPath = path;
		}
		await appendFile(path, lines, "utf8");
	} catch {
		// Debug output must never interfere with the provider stream.
	} finally {
		flushing = false;
	}
}

/** Dump target: SSE_DUMP_PATH, or the legacy CODEX_SSE_DUMP_PATH. */
function dumpPath(): string | undefined {
	return (
		process.env.SSE_DUMP_PATH?.trim() ||
		process.env.CODEX_SSE_DUMP_PATH?.trim() ||
		undefined
	);
}

/**
 * Debug-only JSONL dump. Disabled unless an explicit path is provided through
 * SSE_DUMP_PATH.
 *
 * Writes are buffered in memory and flushed asynchronously in batches so the
 * observer never blocks Pi's message handling on synchronous disk I/O.
 */
export function dumpSseRecord(record: Record<string, unknown>): void {
	const path = dumpPath();
	if (!path) return;

	if (path !== queuedPath) {
		// Path switched: flush anything still queued for the previous path.
		void flush();
		queuedPath = path;
	}
	if (pendingLines.length >= MAX_PENDING_LINES) return;
	pendingLines.push(`${JSON.stringify(record)}\n`);
	if (flushTimer === undefined) {
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			void flush();
		}, FLUSH_INTERVAL_MS);
	}
}

const SECRET_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name,
			SECRET_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value,
		]),
	);
}

/**
 * Dump HTTP response headers and parsed stream events for every provider, using
 * Pi's own `after_provider_response` and `provider_stream_event` hooks. No
 * provider wrapping is needed, so any current or future provider is covered.
 *
 * Lines are `{ts, kind: "headers" | "event", provider, model, ...}`. `event.data`
 * is the parsed event before Pi normalizes it, not the raw SSE frame.
 */
export function registerSseDump(pi: ExtensionAPI): void {
	pi.on("after_provider_response", (event, ctx) => {
		if (!dumpPath()) return;
		dumpSseRecord({
			ts: Date.now(),
			kind: "headers",
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			status: event.status,
			headers: redactHeaders(event.headers),
		});
	});
	pi.on("provider_stream_event", (event) => {
		if (!dumpPath()) return;
		dumpSseRecord({
			ts: Date.now(),
			kind: "event",
			provider: event.provider,
			api: event.api,
			model: event.model,
			data: event.data,
		});
	});
}

/** Flush any buffered dump lines now; exposed for tests and inspection. */
export function flushSseDump(): Promise<void> {
	return flush();
}
