import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
} from "bun:test";
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

function setGlobalWebSocket(value: unknown): void {
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = value;
}

describe("Codex WebSocket observation", () => {
	const original = globalThis.WebSocket;
	let cleanup = () => {};
	let socket: FakeWebSocket;
	let officialCalls = 0;
	const events: Array<Record<string, unknown>> = [];

	beforeAll(() => {
		setGlobalWebSocket(FakeWebSocket);
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
		setGlobalWebSocket(original);
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

describe("Codex WebSocket observer lifecycle", () => {
	const original = globalThis.WebSocket;

	function installFake(): void {
		setGlobalWebSocket(FakeWebSocket);
	}

	afterEach(() => {
		setGlobalWebSocket(original);
	});

	it("stays installed while other observers remain, then restores the global", () => {
		installFake();
		const events: Array<Record<string, unknown>> = [];
		const first = installCodexWebSocketObserver((event) => events.push(event));
		const second = installCodexWebSocketObserver((event) => events.push(event));

		first();
		expect(globalThis.WebSocket).not.toBe(FakeWebSocket as unknown as typeof WebSocket);

		second();
		expect(globalThis.WebSocket).toBe(FakeWebSocket as unknown as typeof WebSocket);
	});

	it("keeps the wrapper transparent for sockets created after uninstall", () => {
		installFake();
		const events: Array<Record<string, unknown>> = [];
		const cleanup = installCodexWebSocketObserver((event) => events.push(event));
		const wrapped = globalThis.WebSocket as unknown as typeof FakeWebSocket;

		const socket = new wrapped("https://example.test/codex/responses", {
			headers: { Authorization: "test" },
		});
		socket.emit("message", '{"type":"before"}');
		expect(events).toEqual([{ type: "before" }]);

		cleanup();
		expect(globalThis.WebSocket).toBe(FakeWebSocket as unknown as typeof WebSocket);

		// Simulates Bun's cached constructor still routing through the old
		// Proxy after uninstall: construction passes through, no observation.
		const stale = new wrapped("https://example.test/codex/responses", {
			headers: { Authorization: "test" },
		});
		expect(FakeWebSocket.lastArgs).toEqual([
			"https://example.test/codex/responses",
			{ headers: { Authorization: "test" } },
		]);
		stale.emit("message", '{"type":"after"}');
		expect(events).toEqual([{ type: "before" }]);
	});

	it("reinstalls cleanly after a full uninstall", () => {
		installFake();
		const firstCleanup = installCodexWebSocketObserver(() => {});
		firstCleanup();
		expect(globalThis.WebSocket).toBe(FakeWebSocket as unknown as typeof WebSocket);

		const events: Array<Record<string, unknown>> = [];
		const cleanup = installCodexWebSocketObserver((event) => events.push(event));
		const socket = new (globalThis.WebSocket as unknown as typeof FakeWebSocket)(
			"https://example.test/codex/responses",
		);
		socket.emit("message", '{"type":"reinstalled"}');
		expect(events).toEqual([{ type: "reinstalled" }]);
		cleanup();
		expect(globalThis.WebSocket).toBe(FakeWebSocket as unknown as typeof WebSocket);
	});
});
