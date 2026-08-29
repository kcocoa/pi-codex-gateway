import {
	createProvider,
	envApiKeyAuth,
	openAIResponsesApi,
} from "@earendil-works/pi-ai";
import { createCodexGatewayModels } from "./codex-gateway.models.ts";

const PROVIDER_ID = "codex-gateway";
const API_ID = "openai-responses";
const DEFAULT_BASE_URL = "https://chatgpt.com/v1";

export function codexGatewayProvider() {
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
		api: openAIResponsesApi(),
	});
}
