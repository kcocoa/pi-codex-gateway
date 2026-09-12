/**
 * A parsed JSON object observed from an SSE response body.
 *
 * This module is deliberately only a response-body observation hook. The
 * provider that owns the request still owns the original fetch, response,
 * retry/abort behavior, and standard response parsing.
 */
export type SseBodyEvent = Record<string, unknown>;
export type SseBodyEventHandler = (event: SseBodyEvent) => void;

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
): typeof globalThis.fetch {
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
			const events = createSseJsonDecoder(onEvent);
			try {
				const reader = observed.body?.getReader();
				if (!reader) return;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					events.push(decoder.decode(value, { stream: true }));
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
