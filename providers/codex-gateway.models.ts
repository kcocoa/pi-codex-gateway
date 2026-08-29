import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export function createCodexGatewayModels(
	providerId: string,
	api: Api,
	baseUrl: string,
): Model<Api>[] {
	return getBuiltinModels("openai-codex").map((model) => ({
		...model,
		api,
		provider: providerId,
		baseUrl,
	}) as Model<Api>);
}
