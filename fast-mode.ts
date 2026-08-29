import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
export type CodexServiceTier = "default" | "priority";

const CONFIG_PATH = join(getAgentDir(), "codex.json");
const DEFAULT_SERVICE_TIER: CodexServiceTier = "default";

interface CodexConfig {
	serviceTier?: CodexServiceTier;
	[key: string]: unknown;
}

export interface CodexFastModeSupport {
	getServiceTier(): CodexServiceTier;
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
			ctx.ui.notify(`Codex service tier: ${serviceTier}`, "info");
		},
	});

	return { getServiceTier: () => serviceTier };
}
