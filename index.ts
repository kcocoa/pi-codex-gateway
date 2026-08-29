import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCodexGpt } from "./codex-provider.ts";
import { registerCyberWarningSupport } from "./cyber-warning.ts";
import {
	registerImageGeneration,
	syncImageGenerationTool,
} from "./image-generation.ts";
import { codexGatewayProvider } from "./providers/codex-gateway.ts";
import { registerOpenAICodexSupport } from "./providers/openai-codex.ts";
import { registerQuotaDisplaySupport } from "./quota-display.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const imageGenerationSkill = join(baseDir, "codex-skills", "imagegen", "SKILL.md");

export default async function codexExtension(pi: ExtensionAPI) {
	const cyberWarnings = await registerCyberWarningSupport(pi);
	const quotaDisplay = registerQuotaDisplaySupport(pi);
	const handleStreamEvent = (event: Record<string, unknown>): void => {
		cyberWarnings.handleStreamEvent(event);
		quotaDisplay.handleStreamEvent(event);
	};
	pi.registerProvider(codexGatewayProvider(handleStreamEvent));
	registerOpenAICodexSupport(pi, handleStreamEvent);
	registerImageGeneration(pi);

	// The imagegen skill and image_gen tool are available only for Codex GPT models.
	pi.on("resources_discover", (_event, ctx) => {
		if (!isCodexGpt(ctx)) return {};
		return { skillPaths: [imageGenerationSkill] };
	});
	pi.on("session_start", (_event, ctx) => syncImageGenerationTool(pi, ctx));
	pi.on("model_select", (_event, ctx) => syncImageGenerationTool(pi, ctx));

	// Both Codex providers support the hosted web-search tool. Add it at
	// serialization time so it remains a provider-native capability.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodexGpt(ctx)) return;

		const payload = event.payload as Record<string, unknown>;
		const tools = Array.isArray(payload.tools) ? payload.tools : [];
		const hasWebSearch = tools.some(
			(tool) => tool && typeof tool === "object" &&
				((tool as { type?: unknown }).type === "web_search" ||
					(tool as { type?: unknown }).type === "web_search_preview"),
		);
		if (hasWebSearch) return;

		return { ...payload, tools: [...tools, { type: "web_search" }] };
	});
}
