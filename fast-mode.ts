import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readCodexConfig, updateCodexConfig } from "./codex-config.ts";
import { isCodexGpt } from "./codex-provider.ts";

export type CodexServiceTier = "default" | "priority";

const DEFAULT_SERVICE_TIER: CodexServiceTier = "default";
// Sort after the quota status in Pi's footer.
const STATUS_KEY = "codex-status-fast";

export interface CodexFastModeSupport {
	getServiceTier(): CodexServiceTier;
}

function isCodexServiceTier(value: unknown): value is CodexServiceTier {
	return value === "default" || value === "priority";
}

export async function registerCodexFastModeSupport(
	pi: ExtensionAPI,
): Promise<CodexFastModeSupport> {
	const config = await readCodexConfig();
	let serviceTier = isCodexServiceTier(config.serviceTier)
		? config.serviceTier
		: DEFAULT_SERVICE_TIER;

	const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const renderStatus = (ctx: ExtensionContext): void => {
		if (!isCodexGpt(ctx) || serviceTier !== "priority") {
			setStatus(ctx, undefined);
			return;
		}
		setStatus(ctx, ctx.ui.theme.fg("dim", "fast⚡"));
	};

	pi.registerCommand("codex:fast", {
		description: "Toggle or set the Codex service tier",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const matches = (["default", "priority"] as const).filter((tier) =>
				tier.startsWith(query),
			);
			return matches.length > 0
				? matches.map((tier) => ({ value: tier, label: tier }))
				: null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested && !isCodexServiceTier(requested)) {
				ctx.ui.notify("Expected one of: default, priority", "error");
				return;
			}
			serviceTier = requested || (serviceTier === "default" ? "priority" : "default");
			await updateCodexConfig("serviceTier", serviceTier);
			renderStatus(ctx);
			ctx.ui.notify(`Codex service tier: ${serviceTier}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => renderStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => setStatus(ctx, undefined));
	pi.on("model_select", (_event, ctx) => renderStatus(ctx));

	return { getServiceTier: () => serviceTier };
}
