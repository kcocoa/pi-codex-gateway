import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { installCodexWebSocketObserver } from "./codex-websocket.ts";

type Listener = (event: { data: unknown }) => void;

class FakeWebSocket {
	static lastArgs: unknown[] | undefined;
	private listeners = new Map<string, Listener[]>();

	constructor(...args: unknown[]) {
		FakeWebSocket.lastArgs = args;
	}

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	emit(type: string, data: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener({ data });
	}
}

describe("Codex WebSocket observation", () => {
	const original = globalThis.WebSocket;
	let cleanup = () => {};
	let socket: FakeWebSocket;
	let officialCalls = 0;
	const events: Array<Record<string, unknown>> = [];

	beforeAll(() => {
		(globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
			FakeWebSocket;
		cleanup = installCodexWebSocketObserver((event) => {
			events.push(event);
		});
		socket = new (globalThis.WebSocket as unknown as typeof FakeWebSocket)(
			"https://example.test/codex/responses",
			{ headers: { Authorization: "test" } },
		);
		socket.addEventListener("message", () => {
			officialCalls++;
		});
	});

	afterAll(() => {
		cleanup();
		(globalThis as unknown as { WebSocket: typeof original }).WebSocket = original;
	});

	it("forwards constructor arguments", () => {
		expect(FakeWebSocket.lastArgs).toEqual([
			"https://example.test/codex/responses",
			{ headers: { Authorization: "test" } },
		]);
	});

	it("observes JSON messages while the official listener also runs", () => {
		socket.emit("message", '{"type":"codex.rate_limits"}');
		expect(events).toEqual([{ type: "codex.rate_limits" }]);
		expect(officialCalls).toBe(1);
	});

	it("fails open when an observer throws", () => {
		const throwingCleanup = installCodexWebSocketObserver(() => {
			throw new Error("observer failure");
		});
		socket.emit("message", '{"type":"response.completed"}');
		throwingCleanup();
		expect(officialCalls).toBe(2);
	});

	it("does not observe non-Codex URLs", () => {
		const nonCodex = new (globalThis.WebSocket as unknown as typeof FakeWebSocket)(
			"https://example.test/v1/responses",
		);
		nonCodex.emit("message", '{"type":"ignored"}');
		expect(events).not.toContainEqual({ type: "ignored" });
	});

	it("does not duplicate the same observer", () => {
		const duplicateEvents: Array<Record<string, unknown>> = [];
		const handler = (event: Record<string, unknown>) => duplicateEvents.push(event);
		const first = installCodexWebSocketObserver(handler);
		const second = installCodexWebSocketObserver(handler);
		socket.emit("message", '{"type":"one"}');
		first();
		second();
		expect(duplicateEvents).toEqual([{ type: "one" }]);
	});
});
