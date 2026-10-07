import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { dumpSseRecord, flushSseDump, registerSseDump } from "./sse-dump.ts";

const TMP_PATH = `/tmp/pi-codex-gateway-sse-dump-test-${process.pid}.jsonl`;

describe("SSE dump", () => {
	beforeAll(() => {
		process.env.SSE_DUMP_PATH = TMP_PATH;
	});

	afterAll(async () => {
		delete process.env.SSE_DUMP_PATH;
		await rm(TMP_PATH, { force: true });
	});

	it("buffers and flushes records asynchronously", async () => {
		dumpSseRecord({ type: "response.created" });
		dumpSseRecord({ type: "response.completed" });
		await flushSseDump();

		const text = await readFile(TMP_PATH, "utf8");
		expect(text).toBe(
			'{"type":"response.created"}\n{"type":"response.completed"}\n',
		);
	});

	it("dumps redacted headers and stream events for any provider", async () => {
		await rm(TMP_PATH, { force: true });
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		registerSseDump({
			on: (name: string, handler: (event: any, ctx: any) => void) => {
				handlers.set(name, handler);
			},
		} as never);

		handlers.get("after_provider_response")?.(
			{
				status: 200,
				headers: { "anthropic-ratelimit-requests-remaining": "9", "set-cookie": "s" },
			},
			{ model: { provider: "anthropic", id: "claude-opus" } },
		);
		handlers.get("provider_stream_event")?.(
			{
				provider: "anthropic",
				api: "anthropic-messages",
				model: "claude-opus",
				data: { type: "message_stop" },
			},
			{},
		);
		await flushSseDump();

		const lines = (await readFile(TMP_PATH, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({
			kind: "headers",
			provider: "anthropic",
			model: "claude-opus",
			status: 200,
			headers: {
				"anthropic-ratelimit-requests-remaining": "9",
				"set-cookie": "[redacted]",
			},
		});
		expect(lines[1]).toMatchObject({
			kind: "event",
			provider: "anthropic",
			api: "anthropic-messages",
			data: { type: "message_stop" },
		});
	});

	it("is disabled without SSE_DUMP_PATH", () => {
		delete process.env.SSE_DUMP_PATH;
		expect(() => dumpSseRecord({ type: "ignored" })).not.toThrow();
	});
});
