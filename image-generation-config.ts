type ExternalToolsConfig = {
	imageGeneration?: boolean;
	imageGenerationForOtherModels?: boolean;
	imagePromptModel?: string;
	imageModel?: string;
};

export type ExternalImageGenerationOptions = {
	/** Expose `image_gen` while the chat model is not a Codex GPT model. */
	forOtherModels: boolean;
	/** Codex model whose credentials and model ID serve the other chat models. */
	promptModel: { provider: string; id: string };
	/** Image model sent to the provider. */
	imageModel: string;
};

export const DEFAULT_IMAGE_PROMPT_MODEL = { provider: "codex-gateway", id: "gpt-6.2-sol" };
export const DEFAULT_IMAGE_MODEL = "gpt-image-2.6-flare";

function externalToolsConfig(config: Record<string, unknown>): ExternalToolsConfig {
	const tools = config.externalTools;
	return !!tools && typeof tools === "object" && !Array.isArray(tools)
		? (tools as ExternalToolsConfig)
		: {};
}

type HostedToolsConfig = {
	imageGeneration?: boolean;
};

/**
 * The local `image_gen` proxy tool is opt-in and mutually exclusive with the
 * provider-hosted image tool.
 */
export function externalImageGenerationEnabled(config: Record<string, unknown>): boolean {
	return externalToolsConfig(config).imageGeneration === true;
}

/** `imagePromptModel` is `provider/model-id`; the model ID may contain slashes. */
export function externalImageGenerationOptions(
	config: Record<string, unknown>,
): ExternalImageGenerationOptions {
	const tools = externalToolsConfig(config);
	const promptModel = typeof tools.imagePromptModel === "string"
		? tools.imagePromptModel.match(/^([^/]+)\/(.+)$/)
		: null;
	return {
		forOtherModels: tools.imageGenerationForOtherModels === true,
		promptModel: promptModel
			? { provider: promptModel[1], id: promptModel[2] }
			: DEFAULT_IMAGE_PROMPT_MODEL,
		imageModel: typeof tools.imageModel === "string" && tools.imageModel
			? tools.imageModel
			: DEFAULT_IMAGE_MODEL,
	};
}

/**
 * The provider-hosted image tool is the default path, so it stays enabled
 * unless it is turned off explicitly. An enabled external namespace tool still
 * wins over it.
 */
export function hostedImageGenerationEnabled(config: Record<string, unknown>): boolean {
	const tools = config.hostedTools;
	return !tools || typeof tools !== "object" || Array.isArray(tools) ||
		(tools as HostedToolsConfig).imageGeneration !== false;
}
