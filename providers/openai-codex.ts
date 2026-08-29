import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type CodexGatewayStreamEventHandler,
	createObservedFetch,
} from "../codex-sse.ts";

const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";

export function registerOpenAICodexSupport(
	pi: ExtensionAPI,
	onStreamEvent: CodexGatewayStreamEventHandler,
): void {
	const api = openAICodexResponsesApi();
	pi.registerProvider(PROVIDER_ID, {
		api: API_ID,
		streamSimple(model, context, options) {
			return api.streamSimple(model, context, {
				...(options ?? {}),
				transport: "sse",
				fetch: createObservedFetch(
					options?.fetch ?? globalThis.fetch,
					onStreamEvent,
				),
			});
		},
	});
}
