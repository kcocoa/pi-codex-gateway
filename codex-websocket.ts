import type { SseBodyEvent, SseBodyEventHandler } from "./codex-sse.ts";

const CODEX_PATH = "/codex/responses";
const INSTALL_KEY = Symbol.for("pi-codex-gateway.websocket-observer");
// Bumped whenever the shared-state shape changes, so a reloaded extension
// never reuses state written by an incompatible version of this module.
const STATE_VERSION = 2;

type ObserverState = {
	version: typeof STATE_VERSION;
	observers: Set<SseBodyEventHandler>;
	/** The installed Proxy; compared before restoring `original`. */
	wrapped: typeof WebSocket;
	/** The constructor that was replaced on install. */
	original: typeof WebSocket;
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

function parseMessage(data: unknown): SseBodyEvent | undefined {
	if (typeof data !== "string") return undefined;
	try {
		const value = JSON.parse(data) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? value as SseBodyEvent
			: undefined;
	} catch {
		return undefined;
	}
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

/**
 * Install a small, read-only observer for Codex WebSocket messages.
 *
 * The install is reference counted: when the last observer unregisters, the
 * global `WebSocket` constructor is restored and the shared state is removed,
 * so a reload that leaves the observer disabled returns the runtime to its
 * pre-extension state instead of leaving a dead Proxy behind.
 */
export function installCodexWebSocketObserver(
	onEvent: SseBodyEventHandler,
): () => void {
	const globalObject = globalThis as WebSocketGlobal;
	let state = globalObject[INSTALL_KEY];
	if (state?.version !== STATE_VERSION || state.disposed) {
		// Unknown, foreign, or already-uninstalled state: start fresh. If the
		// previous global value is an older wrapper, we chain onto it rather
		// than clobbering it; restore then returns to that wrapper.
		state = undefined;
	}

	if (!state) {
		const original = globalThis.WebSocket;
		if (typeof original !== "function") return () => {};

		const localState: ObserverState = {
			version: STATE_VERSION,
			observers: new Set(),
			wrapped: undefined as unknown as typeof WebSocket,
			original,
			disposed: false,
		};

		const wrapped = new Proxy(original, {
			construct(target, args, newTarget) {
				const socket = Reflect.construct(target, args, newTarget) as WebSocket;
				// After uninstall, Bun may still route constructions through this
				// cached Proxy; stay a fully transparent pass-through then.
				if (localState.disposed || !isCodexUrl(args[0])) return socket;

				socket.addEventListener("message", (message) => {
					// Listeners on sockets that outlive the install (Pi's
					// websocket-cached connections) stop parsing after disposal.
					if (localState.disposed) return;
					const event = parseMessage(message.data);
					if (event) dispatch(localState, event);
				});
				return socket;
			},
		});

		localState.wrapped = wrapped as unknown as typeof WebSocket;
		globalObject[INSTALL_KEY] = localState;
		globalThis.WebSocket = wrapped as typeof WebSocket;
		state = localState;
	}

	state.observers.add(onEvent);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		state?.observers.delete(onEvent);
		if (!state || state.observers.size > 0) return;

		// Last observer gone: uninstall the global wrapper.
		state.disposed = true;
		if (globalObject[INSTALL_KEY] === state) delete globalObject[INSTALL_KEY];
		if (globalThis.WebSocket === (state.wrapped as typeof WebSocket)) {
			globalThis.WebSocket = state.original;
		}
	};
}
