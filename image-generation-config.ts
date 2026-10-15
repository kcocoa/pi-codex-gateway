type ExternalToolsConfig = {
	imageGeneration?: boolean;
};

type HostedToolsConfig = {
	imageGeneration?: boolean;
};

/**
 * The local `image_gen` proxy tool is opt-in and mutually exclusive with the
 * provider-hosted image tool.
 */
export function externalImageGenerationEnabled(config: Record<string, unknown>): boolean {
	const tools = config.externalTools;
	return !!tools && typeof tools === "object" && !Array.isArray(tools) &&
		(tools as ExternalToolsConfig).imageGeneration === true;
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
