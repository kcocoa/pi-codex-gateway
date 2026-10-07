import { describe, expect, it } from "bun:test";
import { CODEX_TERMINAL_EVENT_TYPES } from "./codex-sse.ts";
import { createSseEventTapFetch, createSseJsonDecoder } from "./sse-tap.ts";

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(predicate()).toBe(true);
}

describe("SSE body tap", () => {
	it("decodes JSON events across chunk and CRLF boundaries", () => {
		const events: Array<Record<string, unknown>> = [];
		const decoder = createSseJsonDecoder((event) => events.push(event));
		decoder.push('event: response.metadata\r\ndata: {"type":"response.meta');
		decoder.push('data","metadata":{}}\r\n\r\n');
		decoder.finish();
		expect(events).toEqual([{ type: "response.metadata", metadata: {} }]);
	});

	it("passes the response body through while observing SSE events", async () => {
		const encoder = new TextEncoder();
		const chunks = [
			'data: {"type":"response.metadata",',
			'"metadata":{"openai_verification_recommendation":["trusted_access_for_cyber"]}}\n\n',
			"data: [DONE]\n\n",
		];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const originalText = chunks.join("");
		const events: Array<Record<string, unknown>> = [];
		const baseFetch = (async () =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof globalThis.fetch;
		const response = await createSseEventTapFetch(baseFetch, (event) =>
			events.push(event),
		)("https://example.test");

		expect(await response.text()).toBe(originalText);
		expect(events).toEqual([
			{
				type: "response.metadata",
				metadata: {
					openai_verification_recommendation: ["trusted_access_for_cyber"],
				},
			},
		]);
	});

	it("does not consume successful non-SSE responses", async () => {
		const original = new Response("ok", {
			headers: { "content-type": "application/json" },
		});
		const baseFetch = (async () => original) as unknown as typeof globalThis.fetch;
		const observed = await createSseEventTapFetch(baseFetch, () => {
			throw new Error("should not run");
		})("https://example.test");
		expect(observed).toBe(original);
		expect(await observed.text()).toBe("ok");
	});

	it("keeps body bytes unchanged when the observer throws", async () => {
		const originalText = 'data: {"type":"codex.rate_limits"}\r\n\r\n';
		const baseFetch = (async () =>
			new Response(originalText, {
				status: 429,
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof globalThis.fetch;
		const observed = await createSseEventTapFetch(baseFetch, () => {
			throw new Error("observer failure");
		})("https://example.test");

		expect(observed.status).toBe(429);
		expect(observed.headers.get("content-type")).toContain("text/event-stream");
		expect(await observed.text()).toBe(originalText);
	});

	it("observes a UTF-8 event split across byte chunks", async () => {
		const text = 'data: {"type":"response.metadata","label":"é"}\n\n';
		const bytes = new TextEncoder().encode(text);
		const split = text.indexOf("é");
		const events: Array<Record<string, unknown>> = [];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, split + 1));
				controller.enqueue(bytes.slice(split + 1));
				controller.close();
			},
		});
		const baseFetch = (async () =>
			new Response(body, {
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof globalThis.fetch;

		const response = await createSseEventTapFetch(baseFetch, (event) =>
			events.push(event),
		)("https://example.test");
		expect(await response.text()).toBe(text);
		expect(events).toEqual([{ type: "response.metadata", label: "é" }]);
	});

	it("stops reading the clone after the terminal event", async () => {
		let cancelled = false;
		const encoder = new TextEncoder();
		const chunks = [
			'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
			'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
			'data: {"type":"response.metadata","metadata":{}}\n\n',
		];
		// Deliberately never closed: the stream must be cancelled instead.
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			},
			cancel() {
				cancelled = true;
			},
		});
		const baseFetch = (async () =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof globalThis.fetch;
		const events: Array<Record<string, unknown>> = [];
		const response = await createSseEventTapFetch(
			baseFetch,
			(event) => events.push(event),
			{ terminalEventTypes: CODEX_TERMINAL_EVENT_TYPES },
		)("https://example.test");

		// Consume the original branch like Pi's parser: stop at the terminal event.
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		await reader!.read();
		await reader!.cancel();

		await waitUntil(() => cancelled);
		expect(events.map((event) => event.type)).toEqual([
			"response.created",
			"response.completed",
		]);
	});

	it("cancelling the clone branch leaves the provider branch untouched", async () => {
		let sourceCancelled = false;
		const encoder = new TextEncoder();
		const chunks = [
			'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
			'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
			'data: {"type":"response.metadata","metadata":{}}\n\n',
		];
		// Deliberately never closed: only a cancel of BOTH tee branches can
		// end this stream.
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			},
			cancel() {
				sourceCancelled = true;
			},
		});
		const baseFetch = (async () =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof globalThis.fetch;
		const events: Array<Record<string, unknown>> = [];
		const response = await createSseEventTapFetch(
			baseFetch,
			(event) => events.push(event),
			{ terminalEventTypes: CODEX_TERMINAL_EVENT_TYPES },
		)("https://example.test");

		// Wait for the observer branch to cancel itself at the terminal event,
		// then verify the provider branch is unaffected: it can still read the
		// remaining chunks, and the source is only cancelled once Pi cancels
		// its own reader.
		await waitUntil(() => events.some((event) => event.type === "response.completed"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sourceCancelled).toBe(false);

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		expect((await reader!.read()).done).toBe(false);
		expect((await reader!.read()).done).toBe(false);
		expect((await reader!.read()).done).toBe(false);
		expect(sourceCancelled).toBe(false);

		await reader!.cancel();
		await waitUntil(() => sourceCancelled);
	});

	it("honors a provider-specific terminal event (Anthropic message_stop)", async () => {
		let cancelled = false;
		const encoder = new TextEncoder();
		const chunks = [
			'event: message_start\ndata: {"type":"message_start"}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			'event: message_delta\ndata: {"type":"message_delta"}\n\n',
		];
		// Never closed: only the configured terminal event may end observation.
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			},
			cancel() {
				cancelled = true;
			},
		});
		const baseFetch = (async () =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof globalThis.fetch;
		const events: Array<Record<string, unknown>> = [];
		const response = await createSseEventTapFetch(
			baseFetch,
			(event) => events.push(event),
			{ terminalEventTypes: new Set(["message_stop"]) },
		)("https://example.test");

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		await reader!.read();
		await reader!.cancel();

		await waitUntil(() => cancelled);
		expect(events.map((event) => event.type)).toEqual([
			"message_start",
			"content_block_delta",
			"message_stop",
		]);
	});
});
