import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isCodexGpt, isOpenAICodexGpt } from "./codex-provider.ts";
import { readCodexConfig } from "./codex-config.ts";
import { registerHostedImageReception } from "./hosted-image-generation.ts";
import {
	IMAGE_GENERATION_DESCRIPTION,
	IMAGE_GENERATION_NAMESPACE,
	IMAGE_GENERATION_TOOL_NAME,
	IMAGE_GENERATION_WIRE_PARAMETERS,
	registerImageGeneration,
	syncImageGenerationTool,
} from "./external-tools/index.ts";
import { registerCyberWarningSupport } from "./cyber-warning.ts";
import { registerCodexFastModeSupport } from "./fast-mode.ts";
import { codexGatewayProvider } from "./providers/codex-gateway.ts";
import { registerOpenAICodexSupport } from "./providers/openai-codex.ts";
import { registerQuotaDisplaySupport } from "./quota-display.ts";
import { dumpSseEvent } from "./sse-dump.ts";
import { installCodexWebSocketObserver } from "./codex-websocket.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const hostedImageSkill = join(baseDir, "codex-skills", "imagegen-hosted", "SKILL.md");
const externalImageSkill = join(baseDir, "codex-skills", "imagegen", "SKILL.md");

type ExternalToolsConfig = {
	imageGeneration?: boolean;
};

function externalImageGenerationEnabled(config: Record<string, unknown>): boolean {
	const tools = config.externalTools;
	return !!tools && typeof tools === "object" && !Array.isArray(tools) &&
		(tools as ExternalToolsConfig).imageGeneration === true;
}

function namespaceExternalImageTool(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const index = tools.findIndex(
		(tool) => tool.type === "function" && tool.name === IMAGE_GENERATION_TOOL_NAME,
	);
	if (index < 0) return tools;

	const nestedTool: Record<string, unknown> = {
		type: "function",
		name: IMAGE_GENERATION_TOOL_NAME,
		description: IMAGE_GENERATION_DESCRIPTION,
		parameters: IMAGE_GENERATION_WIRE_PARAMETERS,
		strict: false,
	};
	return [
		...tools.slice(0, index),
		{
			type: "namespace",
			name: IMAGE_GENERATION_NAMESPACE,
			description: "Tools in the image_gen namespace.",
			tools: [nestedTool],
		},
		...tools.slice(index + 1),
	];
}

export default async function codexExtension(pi: ExtensionAPI) {
	const config = await readCodexConfig();
	const useExternalImageGeneration = externalImageGenerationEnabled(config);
	const cyberWarnings = await registerCyberWarningSupport(pi);
	let getQuotaStatusWidth = (): number => 0;
	const fastMode = await registerCodexFastModeSupport(
		pi,
		() => getQuotaStatusWidth(),
	);
	const quotaDisplay = registerQuotaDisplaySupport(pi, (ctx) =>
		fastMode.refreshStatus(ctx),
	);
	getQuotaStatusWidth = quotaDisplay.getStatusWidth;
	const hostedImages = registerHostedImageReception(pi);
	const handleBodyEvent = (event: Record<string, unknown>): void => {
		dumpSseEvent(event);
		cyberWarnings.handleBodyEvent(event);
		quotaDisplay.handleBodyEvent(event);
		hostedImages.handleBodyEvent(event);
	};
	const cleanupWebSocketObserver = config.codexWebSocketObserver === true
		? installCodexWebSocketObserver(handleBodyEvent)
		: () => {};
	pi.on("session_shutdown", () => cleanupWebSocketObserver());

	pi.registerProvider(codexGatewayProvider(handleBodyEvent));
	registerOpenAICodexSupport(pi, handleBodyEvent);

	if (useExternalImageGeneration) {
		registerImageGeneration(pi);
		pi.on("session_start", (_event, ctx) => syncImageGenerationTool(pi, ctx));
		pi.on("model_select", (_event, ctx) => syncImageGenerationTool(pi, ctx));
	}

	pi.on("resources_discover", (_event, ctx) => {
		if (!isCodexGpt(ctx)) return {};
		return {
			skillPaths: [useExternalImageGeneration ? externalImageSkill : hostedImageSkill],
		};
	});

	pi.on("session_start", (_event, ctx) => {
		if (!isOpenAICodexGpt(ctx)) return;

		const transport = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getTransport();
		if (transport === "sse") return;

		if (config.codexWebSocketObserver === true) {
			ctx.ui.notify(
				`[pi-codex-gateway] OpenAI Codex is using ${transport} transport with the experimental WebSocket observer. Quota/usage events are observed on a best-effort basis; binary messages and exact request context are unsupported.`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`[pi-codex-gateway] OpenAI Codex is using ${transport} transport. Quota/usage updates and remote Cyber warnings are unavailable on WebSocket responses. To restore them: run /settings → Transport → SSE, or enable codexWebSocketObserver in codex.json.`,
				"warning",
			);
		}
	});
	// Add Codex-native request fields to the existing provider request.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodexGpt(ctx)) return;

		const payload = event.payload as Record<string, unknown>;
		const tools = Array.isArray(payload.tools)
			? (payload.tools as Array<Record<string, unknown>>)
			: [];
		const hasWebSearch = tools.some(
			(tool) =>
				tool.type === "web_search" || tool.type === "web_search_preview",
		);
		const hasHostedImageGeneration = tools.some(
			(tool) => tool.type === "image_generation",
		);
		const additions = [...tools];
		if (!hasWebSearch) additions.push({ type: "web_search" });
		// Expose the hosted image-generation capability unless the explicit
		// external namespace tool is enabled. Both forms in one request conflict.
		if (isCodexGpt(ctx) && !useExternalImageGeneration && !hasHostedImageGeneration) {
			additions.push({ type: "image_generation" });
		}

		const requestTools = useExternalImageGeneration
			? namespaceExternalImageTool(additions)
			: additions;
		const nextPayload = {
			...payload,
			service_tier: fastMode.getServiceTier(),
			tools: requestTools,
		};
		hostedImages.handleProviderRequest(nextPayload, ctx);
		return nextPayload;
	});
}
