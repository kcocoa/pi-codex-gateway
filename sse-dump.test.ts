import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { dumpSseEvent, flushSseDump } from "./sse-dump.ts";

const TMP_PATH = `/tmp/pi-codex-gateway-sse-dump-test-${process.pid}.jsonl`;

describe("SSE dump", () => {
	beforeAll(() => {
		process.env.CODEX_SSE_DUMP_PATH = TMP_PATH;
	});

	afterAll(async () => {
		delete process.env.CODEX_SSE_DUMP_PATH;
		await rm(TMP_PATH, { force: true });
	});

	it("buffers and flushes events asynchronously", async () => {
		dumpSseEvent({ type: "response.created" });
		dumpSseEvent({ type: "response.completed" });
		await flushSseDump();

		const text = await readFile(TMP_PATH, "utf8");
		expect(text).toBe(
			'{"type":"response.created"}\n{"type":"response.completed"}\n',
		);
	});

	it("is disabled without CODEX_SSE_DUMP_PATH", () => {
		delete process.env.CODEX_SSE_DUMP_PATH;
		expect(() => dumpSseEvent({ type: "ignored" })).not.toThrow();
	});
});
