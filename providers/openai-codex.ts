import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createSseEventTapFetch,
	type SseBodyEventHandler,
} from "../codex-sse.ts";

const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";

export function registerOpenAICodexSupport(
	pi: ExtensionAPI,
	onBodyEvent: SseBodyEventHandler,
): void {
	const api = openAICodexResponsesApi();
	pi.registerProvider(PROVIDER_ID, {
		api: API_ID,
		// Keep Pi's official provider in charge of request construction and
		// response parsing; only inject a transparent SSE body observer.
		streamSimple(model, context, options) {
			return api.streamSimple(model, context, {
				...(options ?? {}),
				fetch: createSseEventTapFetch(
					options?.fetch ?? globalThis.fetch,
					onBodyEvent,
				),
			});
		},
	});
}
