import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCyberWarningSupport } from "./cyber-warning.ts";
import {
	isCodexGatewayGpt,
	registerImageGeneration,
	syncImageGenerationTool,
} from "./image-generation.ts";
import { codexGatewayProvider } from "./providers/codex-gateway.ts";
import { registerQuotaDisplaySupport } from "./quota-display.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const imageGenerationSkill = join(baseDir, "codex-skills", "imagegen", "SKILL.md");

export default async function codexGatewayExtension(pi: ExtensionAPI) {
	const cyberWarnings = await registerCyberWarningSupport(pi);
	const quotaDisplay = registerQuotaDisplaySupport(pi);
	pi.registerProvider(
		codexGatewayProvider((event) => {
			cyberWarnings.handleStreamEvent(event);
			quotaDisplay.handleStreamEvent(event);
		}),
	);
	registerImageGeneration(pi);

	// The imagegen skill and image_gen tool are available only for this provider.
	pi.on("resources_discover", (_event, ctx) => {
		if (!isCodexGatewayGpt(ctx)) return {};
		return { skillPaths: [imageGenerationSkill] };
	});
	pi.on("session_start", (_event, ctx) => syncImageGenerationTool(pi, ctx));
	pi.on("model_select", (_event, ctx) => syncImageGenerationTool(pi, ctx));

	// codex-gateway supports the OpenAI Responses API hosted web-search tool.
	// Add it at serialization time so it is a provider-native capability rather
	// than a pi-web-access function tool.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodexGatewayGpt(ctx)) return;

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
