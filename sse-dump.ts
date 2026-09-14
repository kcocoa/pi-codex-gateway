import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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

/**
 * Debug-only dump of parsed SSE JSON events. Disabled unless an explicit path
 * is provided through CODEX_SSE_DUMP_PATH.
 *
 * Writes are buffered in memory and flushed asynchronously in batches so the
 * observer never blocks Pi's message handling on synchronous disk I/O.
 */
export function dumpSseEvent(event: Record<string, unknown>): void {
	const path = process.env.CODEX_SSE_DUMP_PATH?.trim();
	if (!path) return;

	if (path !== queuedPath) {
		// Path switched: flush anything still queued for the previous path.
		void flush();
		queuedPath = path;
	}
	if (pendingLines.length >= MAX_PENDING_LINES) return;
	pendingLines.push(`${JSON.stringify(event)}\n`);
	if (flushTimer === undefined) {
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			void flush();
		}, FLUSH_INTERVAL_MS);
	}
}

/** Flush any buffered dump lines now; exposed for tests and inspection. */
export function flushSseDump(): Promise<void> {
	return flush();
}
