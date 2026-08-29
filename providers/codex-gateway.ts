import {
	createProvider,
	envApiKeyAuth,
	openAIResponsesApi,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
	createObservedFetch,
	type CodexGatewayStreamEventHandler,
} from "../codex-sse.ts";
import { createCodexGatewayModels } from "./codex-gateway.models.ts";

const PROVIDER_ID = "codex-gateway";
const API_ID = "openai-responses";
const DEFAULT_BASE_URL = "https://chatgpt.com/v1";

function createResponsesApi(onStreamEvent?: CodexGatewayStreamEventHandler): ProviderStreams {
	const api = openAIResponsesApi();
	if (!onStreamEvent) return api;

	return {
		stream(model, context, options) {
			return api.stream(model, context, {
				...(options ?? {}),
				fetch: createObservedFetch(options?.fetch ?? globalThis.fetch, onStreamEvent),
			});
		},
		streamSimple(model, context, options) {
			return api.streamSimple(model, context, {
				...(options ?? {}),
				fetch: createObservedFetch(options?.fetch ?? globalThis.fetch, onStreamEvent),
			});
		},
	};
}

export function codexGatewayProvider(onStreamEvent?: CodexGatewayStreamEventHandler) {
	const models = createCodexGatewayModels(PROVIDER_ID, API_ID, DEFAULT_BASE_URL);
	if (models.length === 0) {
		throw new Error(
			"The installed pi build has no openai-codex model catalog to mirror.",
		);
	}
	return createProvider({
		id: PROVIDER_ID,
		name: "Codex Gateway",
		baseUrl: DEFAULT_BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("Codex Gateway API key", ["CODEX_GATEWAY_API_KEY"]),
		},
		models,
		api: createResponsesApi(onStreamEvent),
	});
}
