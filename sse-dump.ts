import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let initializedPath: string | undefined;

/**
 * Debug-only dump of parsed SSE JSON events. Disabled unless an explicit path
 * is provided through CODEX_SSE_DUMP_PATH.
 */
export function dumpSseEvent(event: Record<string, unknown>): void {
	const path = process.env.CODEX_SSE_DUMP_PATH?.trim();
	if (!path) return;

	try {
		if (initializedPath !== path) {
			mkdirSync(dirname(path), { recursive: true });
			initializedPath = path;
		}
		appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
	} catch {
		// Debug output must never interfere with the provider stream.
	}
}
