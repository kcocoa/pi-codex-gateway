import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readCodexConfig, updateCodexConfig } from "./codex-config.ts";
import { isCodexGpt } from "./codex-provider.ts";

export type CodexServiceTier = "default" | "priority";

const DEFAULT_SERVICE_TIER: CodexServiceTier = "default";
const STATUS_KEY = "codex-status-fast";
const ALIGNMENT_SENTINEL = "\u200b";
const NON_BREAKING_SPACE = "\u00a0";
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

function getTerminalWidth(): number | undefined {
	const width = process.stdout.columns ?? process.stderr.columns ?? Number(process.env.COLUMNS);
	return Number.isFinite(width) && width > 0 ? width : undefined;
}

export function visibleStatusWidth(text: string): number {
	const cleanText = text.replace(ANSI_PATTERN, "");
	return [...cleanText].reduce((total, character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		const isWideSymbol =
			(codePoint >= 0x1f000 && codePoint <= 0x1fbff) ||
			(codePoint >= 0x2600 && codePoint <= 0x27bf);
		return total + (isWideSymbol ? 2 : 1);
	}, 0);
}

function rightAlignStatus(text: string, prefixWidth = 0): string {
	const width = getTerminalWidth();
	if (width === undefined) return text;

	const separatorWidth = prefixWidth > 0 ? 1 : 0;
	const padding = Math.max(0, width - prefixWidth - separatorWidth - visibleStatusWidth(text));
	// Pi sanitizes extension statuses by collapsing normal spaces and trimming
	// them. Use an invisible sentinel plus non-breaking spaces so the padding
	// survives that normalization in both old and new Pi versions.
	return ALIGNMENT_SENTINEL + NON_BREAKING_SPACE.repeat(padding) + text;
}

export interface CodexFastModeSupport {
	getServiceTier(): CodexServiceTier;
	refreshStatus(ctx: ExtensionContext): void;
}

function isCodexServiceTier(value: unknown): value is CodexServiceTier {
	return value === "default" || value === "priority";
}

export async function registerCodexFastModeSupport(
	pi: ExtensionAPI,
	getQuotaStatusWidth: () => number = () => 0,
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
		setStatus(
			ctx,
			ctx.ui.theme.fg(
				"dim",
				rightAlignStatus("fast⚡", getQuotaStatusWidth()),
			),
		);
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

	return { getServiceTier: () => serviceTier, refreshStatus: renderStatus };
}
