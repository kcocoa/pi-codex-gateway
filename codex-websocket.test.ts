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
	url?: string;
	private listeners = new Map<string, Listener[]>();

	constructor(...args: unknown[]) {
		FakeWebSocket.lastArgs = args;
		this.url = typeof args[0] === "string" ? args[0] : undefined;
	}

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	send(_data: unknown): void {}

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
		// Every Codex response socket sends its request before receiving.
		socket.send('{"type":"response.create"}');
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

	it("observes binary JSON messages", () => {
		const data = new TextEncoder().encode('{"type":"response.completed"}');
		socket.emit("message", data.buffer);
		expect(events).toContainEqual({ type: "response.completed" });
		expect(officialCalls).toBe(2);
	});

	it("fails open when an observer throws", () => {
		const throwingCleanup = installCodexWebSocketObserver(() => {
			throw new Error("observer failure");
		});
		socket.emit("message", '{"type":"response.completed"}');
		throwingCleanup();
		expect(officialCalls).toBe(3);
	});

	it("does not observe non-Codex URLs", () => {
		const nonCodex = new (globalThis.WebSocket as unknown as typeof FakeWebSocket)(
			"https://example.test/v1/responses",
		);
		nonCodex.send('{"type":"request"}');
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

	function installFake(): typeof FakeWebSocket {
		setGlobalWebSocket(FakeWebSocket);
		return FakeWebSocket;
	}

	afterEach(() => {
		setGlobalWebSocket(original);
	});

	it("keeps the hook installed while other observers remain, then restores send", () => {
		const fake = installFake();
		const originalSend = fake.prototype.send;
		const first = installCodexWebSocketObserver(() => {});
		expect(fake.prototype.send).not.toBe(originalSend);

		const second = installCodexWebSocketObserver(() => {});
		first();
		expect(fake.prototype.send).not.toBe(originalSend);

		second();
		expect(fake.prototype.send).toBe(originalSend);
		expect(globalThis.WebSocket).toBe(fake as unknown as typeof WebSocket);
	});

	it("stops observing sockets that send after uninstall", () => {
		installFake();
		const events: Array<Record<string, unknown>> = [];
		const cleanup = installCodexWebSocketObserver((event) => events.push(event));

		const socket = new (globalThis.WebSocket as unknown as typeof FakeWebSocket)(
			"https://example.test/codex/responses",
			{ headers: { Authorization: "test" } },
		);
		socket.send('{"type":"request"}');
		socket.emit("message", '{"type":"before"}');
		expect(events).toEqual([{ type: "before" }]);

		cleanup();

		// Already-attached listeners are frozen by disposal.
		socket.emit("message", '{"type":"after"}');
		expect(events).toEqual([{ type: "before" }]);

		// Restored send: fresh sockets are no longer observed.
		const fresh = new (globalThis.WebSocket as unknown as typeof FakeWebSocket)(
			"https://example.test/codex/responses",
		);
		fresh.send('{"type":"request"}');
		fresh.emit("message", '{"type":"after"}');
		expect(events).toEqual([{ type: "before" }]);
	});

	it("reinstalls cleanly after a full uninstall", () => {
		installFake();
		const firstCleanup = installCodexWebSocketObserver(() => {});
		firstCleanup();

		const events: Array<Record<string, unknown>> = [];
		const cleanup = installCodexWebSocketObserver((event) => events.push(event));
		const socket = new (globalThis.WebSocket as unknown as typeof FakeWebSocket)(
			"https://example.test/codex/responses",
		);
		socket.send('{"type":"request"}');
		socket.emit("message", '{"type":"reinstalled"}');
		expect(events).toEqual([{ type: "reinstalled" }]);
		cleanup();
	});

	it("observes sockets from a constructor cached before install", () => {
		const fake = installFake();
		// Pi caches the WebSocket constructor before extensions load, so new
		// calls bypass any constructor wrapper. The send hook must still
		// attach the observer to such sockets.
		const cached = globalThis.WebSocket as unknown as typeof FakeWebSocket;
		expect(cached).toBe(fake);
		const originalSend = fake.prototype.send;

		const events: Array<Record<string, unknown>> = [];
		const cleanup = installCodexWebSocketObserver((event) => events.push(event));

		const socket = new cached("https://example.test/codex/responses");
		const nonCodex = new cached("https://example.test/v1/responses");

		socket.send('{"type":"request"}');
		nonCodex.send('{"type":"request"}');
		socket.emit("message", '{"type":"codex.rate_limits"}');
		nonCodex.emit("message", '{"type":"ignored"}');

		expect(events).toEqual([{ type: "codex.rate_limits" }]);

		cleanup();
		expect(fake.prototype.send).toBe(originalSend);

		// After uninstall the send hook is restored and no further
		// observation happens on cached-constructor sockets.
		const after = new cached("https://example.test/codex/responses");
		after.send('{"type":"request"}');
		after.emit("message", '{"type":"after"}');
		expect(events).toEqual([{ type: "codex.rate_limits" }]);
	});
});
