import type { SseBodyEvent, SseBodyEventHandler } from "./codex-sse.ts";

const CODEX_PATH = "/codex/responses";
const INSTALL_KEY = Symbol.for("pi-codex-gateway.websocket-observer");
// Bumped whenever the shared-state shape changes, so a reloaded extension
// never reuses state written by an incompatible version of this module.
const STATE_VERSION = 4;

type ObserverState = {
	version: typeof STATE_VERSION;
	observers: Set<SseBodyEventHandler>;
	prototype: WebSocket["prototype"];
	originalSend: WebSocket["send"];
	wrappedSend: WebSocket["send"];
	/** Sockets that already have the observer listener attached. */
	sockets: WeakSet<object>;
	/** Set when the last observer unregisters; freezes all listener work. */
	disposed: boolean;
};

type WebSocketGlobal = typeof globalThis & {
	[INSTALL_KEY]?: ObserverState;
};

function isCodexUrl(value: unknown): boolean {
	try {
		return new URL(String(value)).pathname.endsWith(CODEX_PATH);
	} catch {
		return false;
	}
}

function parseTextMessage(data: string): SseBodyEvent | undefined {
	try {
		const value = JSON.parse(data) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? value as SseBodyEvent
			: undefined;
	} catch {
		return undefined;
	}
}

function decodeMessageData(
	data: unknown,
): string | undefined | Promise<string | undefined> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(
			new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		);
	}
	if (
		data &&
		typeof data === "object" &&
		"arrayBuffer" in data &&
		typeof data.arrayBuffer === "function"
	) {
		return data.arrayBuffer().then((buffer: ArrayBuffer) =>
			new TextDecoder().decode(new Uint8Array(buffer)),
		);
	}
	return undefined;
}

function observeMessage(state: ObserverState, data: unknown): void {
	const decoded = decodeMessageData(data);
	if (decoded instanceof Promise) {
		void decoded
			.then((text) => {
				if (!state.disposed && text !== undefined) {
					const event = parseTextMessage(text);
					if (event) dispatch(state, event);
				}
			})
			.catch(() => {});
		return;
	}
	if (decoded === undefined) return;
	const event = parseTextMessage(decoded);
	if (event) dispatch(state, event);
}

function dispatch(state: ObserverState, event: SseBodyEvent): void {
	for (const observer of state.observers) {
		try {
			observer(event);
		} catch {
			// Observation must never affect Pi's WebSocket listener.
		}
	}
}

function attachSocketObserver(state: ObserverState, socket: WebSocket): void {
	if (state.disposed || state.sockets.has(socket)) return;
	if (!isCodexUrl((socket as unknown as { url?: unknown }).url)) return;
	state.sockets.add(socket);
	socket.addEventListener("message", (message) => {
		// Sockets can outlive a reload because Pi caches them.
		if (state.disposed) return;
		observeMessage(state, message.data);
	});
}

/**
 * Install a small, read-only observer for Codex WebSocket messages.
 *
 * The hook patches `WebSocket.prototype.send`: every Codex response socket
 * sends its request before receiving events, so the first `send()` on a
 * socket whose URL ends with `/codex/responses` attaches a read-only
 * `message` listener. This works even when the WebSocket constructor was
 * cached before this extension loaded (Pi 0.86+), which a constructor
 * wrapper cannot cover. The outgoing payload is never read.
 *
 * The install is reference counted: when the last observer unregisters,
 * `send` is restored and the shared state is removed, so a reload that
 * leaves the observer disabled returns the runtime to its pre-extension
 * state instead of leaving a dead hook behind.
 */
export function installCodexWebSocketObserver(
	onEvent: SseBodyEventHandler,
): () => void {
	const globalObject = globalThis as WebSocketGlobal;
	let state = globalObject[INSTALL_KEY];
	if (state?.version !== STATE_VERSION || state.disposed) {
		// Unknown, foreign, or already-uninstalled state: start fresh.
		state = undefined;
	}

	if (!state) {
		const prototype = (
			globalThis.WebSocket as unknown as { prototype?: WebSocket["prototype"] }
		).prototype;
		const originalSend = prototype?.send;
		if (typeof originalSend !== "function") return () => {};

		const localState: ObserverState = {
			version: STATE_VERSION,
			observers: new Set(),
			prototype,
			originalSend,
			wrappedSend: undefined as unknown as WebSocket["send"],
			sockets: new WeakSet(),
			disposed: false,
		};

		const wrappedSend = function(
			this: WebSocket,
			...args: Parameters<WebSocket["send"]>
		): ReturnType<WebSocket["send"]> {
			if (!localState.disposed) attachSocketObserver(localState, this);
			return originalSend.apply(this, args);
		};

		try {
			prototype.send = wrappedSend;
		} catch {
			// Non-writable native prototype: observation stays disabled.
			return () => {};
		}
		localState.wrappedSend = wrappedSend;
		globalObject[INSTALL_KEY] = localState;
		state = localState;
	}

	state.observers.add(onEvent);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		state?.observers.delete(onEvent);
		if (!state || state.observers.size > 0) return;

		// Last observer gone: uninstall the prototype hook.
		state.disposed = true;
		if (globalObject[INSTALL_KEY] === state) delete globalObject[INSTALL_KEY];
		if (state.prototype.send === state.wrappedSend) {
			try {
				state.prototype.send = state.originalSend;
			} catch {
				// Ignore runtimes that expose a non-writable native prototype.
			}
		}
	};
}
