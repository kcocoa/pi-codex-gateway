import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { isCodexGpt } from "./codex-provider.ts";

export type CodexServiceTier = "default" | "priority";

const CONFIG_PATH = join(getAgentDir(), "codex.json");
const DEFAULT_SERVICE_TIER: CodexServiceTier = "default";
const STATUS_KEY = "codex-fast";

interface CodexConfig {
	serviceTier?: CodexServiceTier;
	[key: string]: unknown;
}

export interface CodexFastModeSupport {
	getServiceTier(): CodexServiceTier;
}

export function formatFastTierStatus(
	tier: CodexServiceTier,
	fg: (color: "accent" | "dim", text: string) => string,
): string {
	return fg(tier === "priority" ? "accent" : "dim", `fast:${tier}`);
}

function isCodexServiceTier(value: unknown): value is CodexServiceTier {
	return value === "default" || value === "priority";
}

async function readConfig(): Promise<CodexConfig> {
	try {
		const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as CodexConfig)
			: {};
	} catch {
		return {};
	}
}

async function writeServiceTier(serviceTier: CodexServiceTier): Promise<void> {
	const config = await readConfig();
	config.serviceTier = serviceTier;
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function registerCodexFastModeSupport(
	pi: ExtensionAPI,
): Promise<CodexFastModeSupport> {
	const config = await readConfig();
	let serviceTier = isCodexServiceTier(config.serviceTier)
		? config.serviceTier
		: DEFAULT_SERVICE_TIER;

	const setStatus = (
		ctx: ExtensionContext,
		text: string | undefined,
	): void => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// Ignore stale session contexts during reload/session replacement.
		}
	};

	const renderStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!isCodexGpt(ctx)) {
			setStatus(ctx, undefined);
			return;
		}
		setStatus(
			ctx,
			formatFastTierStatus(serviceTier, (color, text) =>
				ctx.ui.theme.fg(color, text),
			),
		);
	};

	pi.registerCommand("codex:fast", {
		description: "Toggle or set the Codex service tier",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const tiers: CodexServiceTier[] = ["default", "priority"];
			const matches = tiers.filter((tier) => tier.startsWith(query));
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

			serviceTier = isCodexServiceTier(requested)
				? requested
				: serviceTier === "default"
					? "priority"
					: "default";
			await writeServiceTier(serviceTier);
			renderStatus(ctx);
			ctx.ui.notify(`Codex service tier: ${serviceTier}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => renderStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => setStatus(ctx, undefined));
	pi.on("model_select", (_event, ctx) => renderStatus(ctx));

	return { getServiceTier: () => serviceTier };
}
