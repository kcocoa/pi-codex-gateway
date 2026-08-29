export type CodexGatewayStreamEvent = Record<string, unknown>;
export type CodexGatewayStreamEventHandler = (
	event: CodexGatewayStreamEvent,
) => void;

export const CODEX_GATEWAY_ERROR_RESPONSE_EVENT =
	"codex.gateway.error_response";

function parseSseData(block: string): CodexGatewayStreamEvent | undefined {
	const data = block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n");
	if (!data || data === "[DONE]") return undefined;

	try {
		const event = JSON.parse(data) as unknown;
		return event && typeof event === "object" && !Array.isArray(event)
			? (event as CodexGatewayStreamEvent)
			: undefined;
	} catch {
		return undefined;
	}
}

export function createSseJsonDecoder(onEvent: CodexGatewayStreamEventHandler) {
	let buffer = "";

	const dispatch = (block: string): void => {
		const event = parseSseData(block);
		if (!event) return;
		try {
			onEvent(event);
		} catch {
			// Signal observers must never break the provider stream.
		}
	};

	const drain = (): void => {
		while (true) {
			const separator = /\r?\n\r?\n/.exec(buffer);
			if (!separator || separator.index === undefined) return;
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

export function createObservedFetch(
	baseFetch: typeof globalThis.fetch,
	onEvent: CodexGatewayStreamEventHandler,
): typeof globalThis.fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await baseFetch(input, init);
		if (!response.ok) {
			try {
				onEvent({
					type: CODEX_GATEWAY_ERROR_RESPONSE_EVENT,
					status: response.status,
					headers: Object.fromEntries(response.headers.entries()),
				});
			} catch {
				// Signal observers must never break provider error handling.
			}
		}
		if (
			!response.body ||
			!response.headers
				.get("content-type")
				?.toLowerCase()
				.includes("text/event-stream")
		) {
			return response;
		}

		const decoder = new TextDecoder();
		const events = createSseJsonDecoder(onEvent);
		const transform = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				events.push(decoder.decode(chunk, { stream: true }));
				controller.enqueue(chunk);
			},
			flush() {
				events.push(decoder.decode());
				events.finish();
			},
		});

		return new Response(response.body.pipeThrough(transform), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}) as typeof globalThis.fetch;
}
