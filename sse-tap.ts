/**
 * Provider-agnostic SSE response-body observation.
 *
 * This module only understands SSE framing and JSON `data:` payloads. It has no
 * knowledge of any provider's event schema, so the same tap can observe Codex /
 * OpenAI Responses, Anthropic Messages, or any other `text/event-stream`
 * response.
 *
 * The provider that owns the request still owns the original fetch, response,
 * retry/abort behavior, and standard response parsing. The tap is a transparent
 * clone branch and is fail-open: it must never break the provider stream.
 *
 * A caller that knows its protocol may pass `terminalEventTypes` so the
 * observer stops reading its clone branch as soon as a response ends. Without
 * it, the observer simply reads until the stream closes.
 */

/** A parsed JSON object observed from an SSE response body. */
export type SseBodyEvent = Record<string, unknown>;
export type SseBodyEventHandler = (event: SseBodyEvent) => void;

export interface SseTapOptions {
	/**
	 * Event `type` values that terminate a response. When one is observed the
	 * clone branch is cancelled early so trailing events cannot leak into the
	 * next turn. Omit for protocols without a known terminal event.
	 */
	terminalEventTypes?: ReadonlySet<string>;
}

function parseSseData(block: string): SseBodyEvent | undefined {
	const data = block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n");
	if (!data || data.trim() === "[DONE]") return undefined;

	try {
		const event = JSON.parse(data) as unknown;
		return event && typeof event === "object" && !Array.isArray(event)
			? (event as SseBodyEvent)
			: undefined;
	} catch {
		return undefined;
	}
}

function safeEmit(onEvent: SseBodyEventHandler, event: SseBodyEvent): void {
	try {
		onEvent(event);
	} catch {
		// Signal observers must never break the provider stream.
	}
}

/** Decode SSE framing for observation without retaining the response body. */
export function createSseJsonDecoder(onEvent: SseBodyEventHandler) {
	let buffer = "";

	const dispatch = (block: string): void => {
		const event = parseSseData(block);
		if (event) safeEmit(onEvent, event);
	};

	const drain = (): void => {
		while (true) {
			const separator = /\r?\n\r?\n/.exec(buffer);
			if (!separator) return;
			const block = buffer.slice(0, separator.index);
			buffer = buffer.slice(separator.index + separator[0].length);
			dispatch(block);
		}
	};

	return {
		push(text: string): void {
			buffer += text;
			drain();
		},
		finish(): void {
			drain();
			if (buffer.trim()) dispatch(buffer);
			buffer = "";
		},
	};
}

/**
 * Wrap fetch with a transparent SSE response-body event tap.
 *
 * Keep returning the provider's original Response. Rebuilding a Response
 * around a TransformStream looks equivalent in browsers, but Bun's HTTP
 * implementation can treat that replacement body as a client-side abort for
 * long-lived SSE requests. A clone gives the observer its own branch while
 * leaving the provider's response, cancellation, and transport untouched.
 */
export function createSseEventTapFetch(
	baseFetch: typeof globalThis.fetch,
	onEvent: SseBodyEventHandler,
	options: SseTapOptions = {},
): typeof globalThis.fetch {
	const terminalEventTypes = options.terminalEventTypes;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await baseFetch(input, init);
		if (
			!response.body ||
			!response.headers
				.get("content-type")
				?.toLowerCase()
				.includes("text/event-stream")
		) {
			return response;
		}

		let observed: Response;
		try {
			observed = response.clone();
		} catch {
			return response;
		}

		void (async () => {
			const decoder = new TextDecoder();
			let finished = false;
			const events = createSseJsonDecoder((event) => {
				onEvent(event);
				if (
					terminalEventTypes &&
					typeof event.type === "string" &&
					terminalEventTypes.has(event.type)
				) {
					finished = true;
				}
			});
			try {
				const reader = observed.body?.getReader();
				if (!reader) return;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					events.push(decoder.decode(value, { stream: true }));
					if (finished) {
						// The provider's parser stops at its own terminal event. Stop
						// reading the clone so it cannot linger and dispatch trailing
						// events (e.g. late metadata) into the next turn.
						void reader.cancel().catch(() => {});
						return;
					}
				}
				events.push(decoder.decode());
				events.finish();
			} catch {
				// Observation is fail-open and must never abort the provider branch.
			}
		})();

		return response;
	}) as typeof globalThis.fetch;
}

/**
 * Attach the SSE tap to a provider's stream options, preserving every other
 * option. Works with any API implementation that forwards `options.fetch`.
 */
export function withSseBodyEventTap<
	T extends { fetch?: typeof globalThis.fetch },
>(
	options: T | undefined,
	onEvent: SseBodyEventHandler,
	tapOptions?: SseTapOptions,
): T & { fetch: typeof globalThis.fetch } {
	return {
		...(options ?? {}),
		fetch: createSseEventTapFetch(
			options?.fetch ?? globalThis.fetch,
			onEvent,
			tapOptions,
		),
	} as T & { fetch: typeof globalThis.fetch };
}
