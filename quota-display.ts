import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isCodexGpt } from "./codex-provider.ts";
import { visibleStatusWidth } from "./fast-mode.ts";
import type { SseBodyEvent } from "./codex-sse.ts";
import {
	formatWindowLabel,
	parseRateLimitBodyEvent,
	parseRateLimitHeaders,
	type RateLimitSnapshot,
	type RateLimitUpdate,
	type RateLimitWindow,
	remainingPercent,
} from "./rate-limits.ts";

const STATUS_KEY = "codex-quota";

function debugEnabled(): boolean {
	const value = process.env.DEBUG?.trim().toLowerCase();
	return value === "1" || value === "true";
}

function debugNotify(ctx: ExtensionContext | undefined, message: string): void {
	if (!debugEnabled()) return;
	const line = `[quota-debug] ${new Date().toISOString().slice(11, 19)} ${message}`;
	// notify messages land in the chat scrollback, so the TUI repaint
	// cannot erase them. stderr is only a fallback for headless runs.
	if (ctx?.hasUI) ctx.ui.notify(line, "info");
	else console.error(line);
}

function debugWindowText(window: RateLimitWindow, fallback: string): string {
	const label = formatWindowLabel(window, fallback);
	const reset = formatResetCountdown(window.resetsAt);
	return `${label}:${formatPercent(remainingPercent(window))}%${reset ? `↺${reset}` : ""}`;
}

function debugUpdateText(update: RateLimitUpdate): string {
	return (
		update.snapshots
			.map((snapshot) => {
				const parts = [snapshot.limitId];
				if (snapshot.primary)
					parts.push(debugWindowText(snapshot.primary, "primary"));
				if (snapshot.secondary)
					parts.push(debugWindowText(snapshot.secondary, "secondary"));
				if (snapshot.credits)
					parts.push(
						`credits:${snapshot.credits.balance ?? (snapshot.credits.hasCredits ? "yes" : "no")}`,
					);
				return parts.join(" ");
			})
			.join(" | ") || "no snapshots"
	);
}

export interface QuotaDisplaySupport {
	handleResponseHeaders(
		headers: Record<string, string>,
		ctx: ExtensionContext,
	): void;
	handleBodyEvent(event: SseBodyEvent, ctx?: ExtensionContext): void;
	getStatusWidth(): number;
}

function mergeSnapshot(
	previous: RateLimitSnapshot | undefined,
	next: RateLimitSnapshot,
): RateLimitSnapshot {
	return {
		limitId: next.limitId,
		limitName: next.limitName ?? previous?.limitName,
		primary: next.primary ?? previous?.primary,
		secondary: next.secondary ?? previous?.secondary,
		credits: next.credits ?? previous?.credits,
		planType: next.planType ?? previous?.planType,
	};
}

function sameSnapshot(
	left: RateLimitSnapshot | undefined,
	right: RateLimitSnapshot,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
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

export function formatSubscriptionType(
	planType: string | undefined,
): string | undefined {
	const raw = planType?.trim();
	if (!raw) return undefined;
	const normalized = raw.toLowerCase().replaceAll(/[-\s]+/g, "_");
	switch (normalized) {
		case "plus":
			return "plus";
		case "prolite":
		case "pro_lite":
		case "pro5x":
		case "pro_5x":
			return "pro5x";
		case "pro":
		case "pro20x":
		case "pro_20x":
			return "pro20x";
		case "team":
		case "business":
			return "business";
		case "self_serve_business_prolite":
		case "self_serve_business_usage_based":
		case "business_pro":
		case "businesspro":
			return "business pro";
		default:
			return undefined;
	}
}

export function formatResetCountdown(
	resetsAt: number | undefined,
	nowMs = Date.now(),
): string | undefined {
	if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0)
		return undefined;
	let remaining = Math.ceil(resetsAt - nowMs / 1000);
	if (remaining <= 0) return "now";
	const parts: string[] = [];
	for (const [suffix, seconds] of [
		["d", 86_400],
		["h", 3_600],
		["m", 60],
		["s", 1],
	] as const) {
		const value = Math.floor(remaining / seconds);
		remaining %= seconds;
		if (value > 0) parts.push(`${value}${suffix}`);
		if (parts.length === 2) break;
	}
	return parts.length > 0 ? parts.join("") : "now";
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
	onStatusChange?: (ctx: ExtensionContext) => void,
): QuotaDisplaySupport {
	const snapshots = new Map<string, RateLimitSnapshot>();
	let activeContext: ExtensionContext | undefined;
	let activeLimitId: string | undefined;
	let planType: string | undefined;
	let promoMessage: string | undefined;
	let rateLimitReachedType: string | undefined;
	let lastUpdatedAt: number | undefined;
	let statusWidth = 0;

	const clearState = (): void => {
		snapshots.clear();
		activeLimitId = undefined;
		planType = undefined;
		promoMessage = undefined;
		rateLimitReachedType = undefined;
		lastUpdatedAt = undefined;
		statusWidth = 0;
	};

	const selectSnapshot = (): RateLimitSnapshot | undefined => {
		const hasWindows = (snapshot: RateLimitSnapshot | undefined): boolean =>
			snapshot?.primary !== undefined || snapshot?.secondary !== undefined;
		const active = activeLimitId ? snapshots.get(activeLimitId) : undefined;
		if (hasWindows(active)) return active;
		const defaultSnapshot = snapshots.get("codex");
		if (hasWindows(defaultSnapshot)) return defaultSnapshot;
		return [...snapshots.values()].find(hasWindows);
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text);
		onStatusChange?.(ctx);
	};

	const renderStatus = (ctx: ExtensionContext): void => {
		if (!isCodexGpt(ctx)) {
			setStatus(ctx, undefined);
			return;
		}
		const snapshot = selectSnapshot();
		const parts: string[] = [];
		const subscription = formatSubscriptionType(planType ?? snapshot?.planType);
		if (subscription) parts.push(ctx.ui.theme.fg("dim", subscription));
		for (const [fallback, window] of [
			["primary", snapshot?.primary],
			["secondary", snapshot?.secondary],
		] as const) {
			if (!window) continue;
			const label = formatWindowLabel(window, fallback);
			const remaining = `${formatPercent(remainingPercent(window))}%`;
			const reset = formatResetCountdown(window.resetsAt);
			parts.push(
				ctx.ui.theme.fg("dim", `${label}:`) +
					ctx.ui.theme.fg(severityColor(window), remaining) +
					(reset ? ctx.ui.theme.fg("dim", `↺${reset}`) : ""),
			);
		}
		if (parts.length === 0) {
			statusWidth = 0;
			setStatus(ctx, undefined);
			return;
		}
		const statusText = parts.join(" ");
		statusWidth = visibleStatusWidth(statusText);
		setStatus(ctx, statusText);
	};

	const applyUpdate = (
		update: RateLimitUpdate,
		ctx: ExtensionContext,
	): boolean => {
		// Provider callbacks are synchronous and arrive in response/retry order.
		// Merge partial snapshots instead of replacing them so a later retry or
		// a duplicate source cannot regress fields that were already observed.
		let changed = false;
		for (const snapshot of update.snapshots) {
			const previous = snapshots.get(snapshot.limitId);
			const merged = mergeSnapshot(previous, snapshot);
			if (!sameSnapshot(previous, merged)) {
				snapshots.set(snapshot.limitId, merged);
				changed = true;
			}
		}
		if (
			update.activeLimitId !== undefined &&
			update.activeLimitId !== activeLimitId
		) {
			activeLimitId = update.activeLimitId;
			changed = true;
		}
		const nextPlanType = update.snapshots.find(
			(snapshot) => snapshot.planType,
		)?.planType;
		if (nextPlanType !== undefined && nextPlanType !== planType) {
			planType = nextPlanType;
			changed = true;
		}
		if (
			update.promoMessage !== undefined &&
			update.promoMessage !== promoMessage
		) {
			promoMessage = update.promoMessage;
			changed = true;
		}
		if (
			update.rateLimitReachedType !== undefined &&
			update.rateLimitReachedType !== rateLimitReachedType
		) {
			rateLimitReachedType = update.rateLimitReachedType;
			changed = true;
		}
		if (!changed) return false;
		lastUpdatedAt = Date.now();
		renderStatus(ctx);
		return true;
	};

	const formatDetails = (): string => {
		if (snapshots.size === 0 && !promoMessage && !rateLimitReachedType) {
			return "No Codex quota data has been observed in response headers or SSE body events yet.";
		}

		const lines = [
			`Codex quota${lastUpdatedAt ? ` (updated ${new Date(lastUpdatedAt).toLocaleString()})` : ""}`,
		];
		const subscription = formatSubscriptionType(planType);
		if (subscription) lines.push(`Plan: ${subscription}`);
		for (const snapshot of [...snapshots.values()].sort((a, b) =>
			a.limitId.localeCompare(b.limitId),
		)) {
			const active = snapshot.limitId === activeLimitId ? " [active]" : "";
			const name = snapshot.limitName ? ` — ${snapshot.limitName}` : "";
			lines.push(`${snapshot.limitId}${name}${active}`);
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
		renderStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		clearState();
		activeContext = isCodexGpt(ctx) ? ctx : undefined;
		setStatus(ctx, undefined);
	});
	const handleResponseHeaders = (
		headers: Record<string, string>,
		ctx: ExtensionContext,
	): void => {
		if (!isCodexGpt(ctx)) return;
		const update = parseRateLimitHeaders(headers);
		const refreshed = update ? applyUpdate(update, ctx) : false;
		debugNotify(
			ctx,
			update
				? `source=hdr updated=${refreshed ? "true" : "false(dup)"} ${debugUpdateText(update)}`
				: "source=hdr updated=false(no headers)",
		);
	};

	const handleBodyEvent = (
		event: SseBodyEvent,
		ctx?: ExtensionContext,
	): void => {
		const typeText = String(event.type);
		if (!/limit|usage|rate|credit/i.test(typeText)) return;
		const active = ctx ?? activeContext;
		if (!active || !isCodexGpt(active)) {
			debugNotify(ctx, "source=sse updated=false(skip:no ctx)");
			return;
		}
		const update = parseRateLimitBodyEvent(event);
		const refreshed = update ? applyUpdate(update, active) : false;
		debugNotify(
			active,
			update
				? `source=sse updated=${refreshed ? "true" : "false(dup)"} ${debugUpdateText(update)}`
				: `source=sse updated=false(no fields) type=${typeText}`,
		);
	};

	pi.on("after_provider_response", (event, ctx) => {
		handleResponseHeaders(event.headers, ctx);
	});

	return { handleResponseHeaders, handleBodyEvent, getStatusWidth: () => statusWidth };
}
