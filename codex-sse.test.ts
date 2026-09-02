import { describe, expect, it } from "bun:test";
import { createSseEventTapFetch, createSseJsonDecoder } from "./codex-sse.ts";

describe("Codex SSE observation", () => {
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
			})) as typeof globalThis.fetch;
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
		const baseFetch = (async () => original) as typeof globalThis.fetch;
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
			})) as typeof globalThis.fetch;
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
			})) as typeof globalThis.fetch;

		const response = await createSseEventTapFetch(baseFetch, (event) =>
			events.push(event),
		)("https://example.test");
		expect(await response.text()).toBe(text);
		expect(events).toEqual([{ type: "response.metadata", label: "é" }]);
	});
});
