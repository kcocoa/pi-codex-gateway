import {
	createProvider,
	envApiKeyAuth,
	type Api,
	type Model,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	createObservedFetch,
	type CodexGatewayStreamEventHandler,
} from "../codex-sse.ts";

const PROVIDER_ID = "codex-gateway";
const API_ID = "openai-responses";
const DEFAULT_BASE_URL = "https://chatgpt.com/v1";

function createResponsesApi(
	onStreamEvent: CodexGatewayStreamEventHandler,
): ProviderStreams {
	const api = openAIResponsesApi();
	const withObservedFetch = (options?: { fetch?: typeof globalThis.fetch }) => ({
		...(options ?? {}),
		fetch: createObservedFetch(
			options?.fetch ?? globalThis.fetch,
			onStreamEvent,
		),
	});
	return {
		stream(model, context, options) {
			return api.stream(model, context, withObservedFetch(options));
		},
		streamSimple(model, context, options) {
			return api.streamSimple(model, context, withObservedFetch(options));
		},
	};
}

export function codexGatewayProvider(
	onStreamEvent: CodexGatewayStreamEventHandler,
) {
	const models = getBuiltinModels("openai-codex").map(
		(model) =>
			({
				...model,
				api: API_ID,
				provider: PROVIDER_ID,
				baseUrl: DEFAULT_BASE_URL,
			}) as Model<Api>,
	);
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
