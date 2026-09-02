import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCodexGpt } from "./codex-provider.ts";
import { registerCyberWarningSupport } from "./cyber-warning.ts";
import { registerCodexFastModeSupport } from "./fast-mode.ts";
import {
	registerImageGeneration,
	syncImageGenerationTool,
} from "./image-generation.ts";
import { codexGatewayProvider } from "./providers/codex-gateway.ts";
import { registerOpenAICodexSupport } from "./providers/openai-codex.ts";
import { registerQuotaDisplaySupport } from "./quota-display.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const imageGenerationSkill = join(
	baseDir,
	"codex-skills",
	"imagegen",
	"SKILL.md",
);

export default async function codexExtension(pi: ExtensionAPI) {
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
	const handleBodyEvent = (event: Record<string, unknown>): void => {
		cyberWarnings.handleBodyEvent(event);
		quotaDisplay.handleBodyEvent(event);
	};
	pi.registerProvider(codexGatewayProvider(handleBodyEvent));
	registerOpenAICodexSupport(pi, handleBodyEvent);
	registerImageGeneration(pi);

	// The imagegen skill and image_gen tool are available only for Codex GPT models.
	pi.on("resources_discover", (_event, ctx) => {
		if (!isCodexGpt(ctx)) return {};
		return { skillPaths: [imageGenerationSkill] };
	});
	pi.on("session_start", (_event, ctx) => syncImageGenerationTool(pi, ctx));
	pi.on("model_select", (_event, ctx) => syncImageGenerationTool(pi, ctx));

	// Add Codex-native request fields to the existing provider request.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodexGpt(ctx)) return;

		const payload = event.payload as Record<string, unknown>;
		const tools = Array.isArray(payload.tools)
			? (payload.tools as Array<{ type?: string }>)
			: [];
		const hasWebSearch = tools.some(
			(tool) =>
				tool.type === "web_search" || tool.type === "web_search_preview",
		);

		return {
			...payload,
			service_tier: fastMode.getServiceTier(),
			...(hasWebSearch ? {} : { tools: [...tools, { type: "web_search" }] }),
		};
	});
}
