import type { SseBodyEvent, SseBodyEventHandler } from "./codex-sse.ts";

const CODEX_PATH = "/codex/responses";
const INSTALL_KEY = Symbol.for("pi-codex-gateway.websocket-observer");

type ObserverState = {
	observers: Set<SseBodyEventHandler>;
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

/** Install a small, read-only observer for Codex WebSocket messages. */
export function installCodexWebSocketObserver(
	onEvent: SseBodyEventHandler,
): () => void {
	const globalObject = globalThis as WebSocketGlobal;
	let state = globalObject[INSTALL_KEY];

	if (!state) {
		state = { observers: new Set() };
		const original = globalThis.WebSocket;
		if (typeof original !== "function") return () => {};

		const wrapped = new Proxy(original, {
			construct(target, args, newTarget) {
				const socket = Reflect.construct(target, args, newTarget) as WebSocket;
				if (!isCodexUrl(args[0])) return socket;

				socket.addEventListener("message", (message) => {
					const event = parseMessage(message.data);
					if (event) dispatch(state!, event);
				});
				return socket;
			},
		});

		globalObject[INSTALL_KEY] = state;
		globalThis.WebSocket = wrapped as typeof globalThis.WebSocket;
	}

	state.observers.add(onEvent);
	return () => {
		state?.observers.delete(onEvent);
	};
}
