import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isCodexGpt } from "./codex-provider.ts";
import type { CodexGatewayStreamEvent } from "./codex-sse.ts";
import {
	formatWindowLabel,
	parseRateLimitHeaders,
	parseRateLimitStreamEvent,
	type RateLimitSnapshot,
	type RateLimitUpdate,
	type RateLimitWindow,
	remainingPercent,
} from "./rate-limits.ts";

const STATUS_KEY = "codex-quota";

export interface QuotaDisplaySupport {
	handleStreamEvent(event: CodexGatewayStreamEvent): void;
}

function mergeSnapshot(
	previous: RateLimitSnapshot | undefined,
	next: RateLimitSnapshot,
): RateLimitSnapshot {
	return {
		...next,
		limitName: next.limitName ?? previous?.limitName,
		credits: next.credits ?? previous?.credits,
		planType: next.planType ?? previous?.planType,
	};
}

function severityColor(window: RateLimitWindow): "dim" | "warning" | "error" {
	if (window.usedPercent >= 90) return "error";
	if (window.usedPercent >= 75) return "warning";
	return "dim";
}

function formatPercent(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatReset(resetsAt: number | undefined): string {
	if (resetsAt === undefined) return "unknown";
	return new Date(resetsAt * 1000).toLocaleString();
}

function formatWindowDetails(
	name: string,
	window: RateLimitWindow | undefined,
): string | undefined {
	if (!window) return undefined;
	const label = formatWindowLabel(window, name);
	return (
		`  ${name} (${label}): ${formatPercent(window.usedPercent)}% used, ` +
		`${formatPercent(remainingPercent(window))}% left, resets ${formatReset(window.resetsAt)}`
	);
}

export function registerQuotaDisplaySupport(
	pi: ExtensionAPI,
): QuotaDisplaySupport {
	const snapshots = new Map<string, RateLimitSnapshot>();
	let activeContext: ExtensionContext | undefined;
	let activeLimitId: string | undefined;
	let promoMessage: string | undefined;
	let rateLimitReachedType: string | undefined;
	let lastUpdatedAt: number | undefined;

	const clearState = (): void => {
		snapshots.clear();
		activeLimitId = undefined;
		promoMessage = undefined;
		rateLimitReachedType = undefined;
		lastUpdatedAt = undefined;
	};

	const selectSnapshot = (): RateLimitSnapshot | undefined => {
		if (activeLimitId && snapshots.has(activeLimitId))
			return snapshots.get(activeLimitId);
		return (
			snapshots.get("codex") ??
			[...snapshots.values()].find(
				(snapshot) =>
					snapshot.primary || snapshot.secondary || snapshot.credits,
			)
		);
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
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
		const snapshot = selectSnapshot();
		if (!snapshot) {
			setStatus(ctx, undefined);
			return;
		}
		const parts: string[] = [];
		for (const [fallback, window] of [
			["primary", snapshot.primary],
			["secondary", snapshot.secondary],
		] as const) {
			if (!window) continue;
			const label = formatWindowLabel(window, fallback);
			const remaining = `${formatPercent(remainingPercent(window))}%`;
			parts.push(
				ctx.ui.theme.fg("dim", `${label}:`) +
					ctx.ui.theme.fg(severityColor(window), remaining),
			);
		}
		if (parts.length === 0 && snapshot.credits) {
			const credits = snapshot.credits.unlimited
				? "∞"
				: (snapshot.credits.balance ??
					(snapshot.credits.hasCredits ? "available" : "none"));
			parts.push(
				ctx.ui.theme.fg("dim", "credits:") + ctx.ui.theme.fg("dim", credits),
			);
		}
		if (parts.length === 0) {
			setStatus(ctx, undefined);
			return;
		}
		const prefix =
			snapshot.limitId === "codex"
				? ""
				: `${snapshot.limitName ?? snapshot.limitId} `;
		setStatus(ctx, `${prefix}${parts.join(" ")}`);
	};

	const applyUpdate = (
		update: RateLimitUpdate,
		ctx: ExtensionContext,
	): void => {
		const now = Date.now();
		for (const snapshot of update.snapshots) {
			const previous = snapshots.get(snapshot.limitId);
			snapshots.set(snapshot.limitId, mergeSnapshot(previous, snapshot));
		}
		activeLimitId = update.activeLimitId ?? activeLimitId;
		promoMessage = update.promoMessage ?? promoMessage;
		rateLimitReachedType = update.rateLimitReachedType ?? rateLimitReachedType;
		lastUpdatedAt = now;
		renderStatus(ctx);
	};

	const formatDetails = (): string => {
		if (snapshots.size === 0 && !promoMessage && !rateLimitReachedType) {
			return "No Codex quota data has been observed in response headers or stream events yet.";
		}

		const lines = [
			`Codex quota${lastUpdatedAt ? ` (updated ${new Date(lastUpdatedAt).toLocaleString()})` : ""}`,
		];
		for (const snapshot of [...snapshots.values()].sort((a, b) =>
			a.limitId.localeCompare(b.limitId),
		)) {
			const active = snapshot.limitId === activeLimitId ? " [active]" : "";
			const name = snapshot.limitName ? ` — ${snapshot.limitName}` : "";
			lines.push(`${snapshot.limitId}${name}${active}`);
			if (snapshot.planType) lines.push(`  Plan: ${snapshot.planType}`);
			const primary = formatWindowDetails("Primary", snapshot.primary);
			const secondary = formatWindowDetails("Secondary", snapshot.secondary);
			if (primary) lines.push(primary);
			if (secondary) lines.push(secondary);
			if (snapshot.credits) {
				const creditParts = [
					`available=${snapshot.credits.hasCredits ? "yes" : "no"}`,
					`unlimited=${snapshot.credits.unlimited ? "yes" : "no"}`,
				];
				if (snapshot.credits.balance)
					creditParts.push(`balance=${snapshot.credits.balance}`);
				lines.push(`  Credits: ${creditParts.join(", ")}`);
			}
		}
		if (rateLimitReachedType)
			lines.push(`Reached type: ${rateLimitReachedType}`);
		if (promoMessage) lines.push(`Message: ${promoMessage}`);
		return lines.join("\n");
	};

	pi.registerCommand("codex:usage", {
		description: "Show the latest Codex quota snapshot",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatDetails(), snapshots.size > 0 ? "info" : "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearState();
		activeContext = isCodexGpt(ctx) ? ctx : undefined;
		setStatus(ctx, undefined);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		activeContext = undefined;
		setStatus(ctx, undefined);
	});
	pi.on("turn_start", (_event, ctx) => {
		activeContext = isCodexGpt(ctx) ? ctx : undefined;
	});
	pi.on("model_select", (_event, ctx) => {
		clearState();
		activeContext = isCodexGpt(ctx) ? ctx : undefined;
		setStatus(ctx, undefined);
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (!isCodexGpt(ctx)) return;
		const update = parseRateLimitHeaders(event.headers);
		if (update) applyUpdate(update, ctx);
	});

	return {
		handleStreamEvent(event) {
			const ctx = activeContext;
			if (!ctx || !isCodexGpt(ctx)) return;
			const update = parseRateLimitStreamEvent(event);
			if (update) applyUpdate(update, ctx);
		},
	};
}
