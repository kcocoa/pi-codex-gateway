import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isAnthropic, isCodexGpt } from "./codex-provider.ts";
import type { SseBodyEvent } from "./sse-tap.ts";
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

/** Resolved once: the timezone the user's wall clock is in. */
const LOCAL_TIME_ZONE =
	Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function debugEnabled(): boolean {
	const value = process.env.DEBUG?.trim().toLowerCase();
	return value === "1" || value === "true";
}

function debugNotify(ctx: ExtensionContext | undefined, message: string): void {
	if (!debugEnabled()) return;
	const line = `[quota-debug] ${formatLocalStamp(new Date(), LOCAL_TIME_ZONE, true)} ${message}`;
	// notify messages land in the chat scrollback, so the TUI repaint
	// cannot erase them. stderr is only a fallback for headless runs.
	if (ctx?.hasUI) ctx.ui.notify(line, "info");
	else console.error(line);
}

function debugWindowText(window: RateLimitWindow, fallback: string): string {
	const label = formatWindowLabel(window, fallback);
	const reset = formatWindowReset(window, label);
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

/** The window has reset since it was observed, so its usage is unknown. */
function isStale(window: RateLimitWindow, nowMs = Date.now()): boolean {
	return window.resetsAt !== undefined && window.resetsAt * 1000 <= nowMs;
}

function isSupportedQuotaContext(
	ctx: Pick<ExtensionContext, "model"> | undefined,
): boolean {
	if (!ctx) return false;
	return isCodexGpt(ctx) || isAnthropic(ctx);
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

/**
 * ISO-like stamp in `timeZone`, e.g. `2026-10-08 00:00`. Built from numeric
 * parts so the output does not depend on the host locale.
 */
export function formatLocalStamp(
	date: Date,
	timeZone = LOCAL_TIME_ZONE,
	withSeconds = false,
): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		...(withSeconds ? { second: "2-digit" as const } : {}),
	}).formatToParts(date);
	const part = (type: string): string =>
		parts.find((candidate) => candidate.type === type)?.value ?? "";
	const time = withSeconds
		? `${part("hour")}:${part("minute")}:${part("second")}`
		: `${part("hour")}:${part("minute")}`;
	return `${part("year")}-${part("month")}-${part("day")} ${time}`;
}

/** Offset in effect at `date`, e.g. `UTC+08:00`. DST-aware because per date. */
function localOffsetLabel(date: Date, timeZone: string): string {
	const name = new Intl.DateTimeFormat("en-US", {
		timeZone,
		timeZoneName: "longOffset",
	})
		.formatToParts(date)
		.find((part) => part.type === "timeZoneName")?.value;
	if (!name || name === "GMT") return "UTC+00:00";
	return name.replace(/^GMT/, "UTC");
}

/** Absolute time in the local timezone, e.g. `2026-10-08 00:00 (UTC+08:00)`. */
export function formatLocalDateTime(
	ms: number,
	timeZone = LOCAL_TIME_ZONE,
): string {
	const date = new Date(ms);
	if (!Number.isFinite(date.getTime())) return "unknown";
	return `${formatLocalStamp(date, timeZone)} (${localOffsetLabel(date, timeZone)})`;
}

/**
 * A reset value is a unix timestamp, so its meaning is timezone-independent;
 * only the rendering is aligned to the user's timezone.
 */
export function formatReset(
	resetsAt: number | undefined,
	timeZone = LOCAL_TIME_ZONE,
): string {
	if (resetsAt === undefined) return "unknown";
	return formatLocalDateTime(resetsAt * 1000, timeZone);
}

/** 24-hour clock time in `timeZone`, e.g. `14:30`. */
export function formatResetClock(
	resetsAt: number | undefined,
	timeZone = LOCAL_TIME_ZONE,
): string | undefined {
	if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0)
		return undefined;
	const date = new Date(resetsAt * 1000);
	if (!Number.isFinite(date.getTime())) return undefined;
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const part = (type: string): string =>
		parts.find((candidate) => candidate.type === type)?.value ?? "";
	return `${part("hour")}:${part("minute")}`;
}

/**
 * Format reset text for a quota window.
 *
 * For the 5h window, when remaining quota is < 10% or refresh time is < 1h,
 * display the reset moment as `HH:MM` in the local timezone. Also applies
 * whenever any window's refresh time is < 1h. If the reset time has passed,
 * renders "now". Otherwise renders the relative countdown (e.g. "3h44m").
 */
export function formatWindowReset(
	window: RateLimitWindow,
	label: string,
	nowMs = Date.now(),
	timeZone = LOCAL_TIME_ZONE,
): string | undefined {
	if (
		window.resetsAt === undefined ||
		!Number.isFinite(window.resetsAt) ||
		window.resetsAt <= 0
	) {
		return undefined;
	}
	if (isStale(window, nowMs)) return "now";

	const remainingSec = window.resetsAt - nowMs / 1000;
	const is5h = label === "5h" || window.windowMinutes === 300;
	const showClock =
		(is5h && remainingPercent(window) < 10) ||
		(remainingSec > 0 && remainingSec < 3_600);

	if (showClock) {
		return formatResetClock(window.resetsAt, timeZone);
	}
	return formatResetCountdown(window.resetsAt, nowMs);
}

function formatWindowDetails(
	name: string,
	window: RateLimitWindow | undefined,
): string | undefined {
	if (!window) return undefined;
	const label = formatWindowLabel(window, name);
	if (isStale(window))
		return `  ${name} (${label}): unknown, reset at ${formatReset(window.resetsAt)} has passed`;
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

	const clearState = (): void => {
		snapshots.clear();
		activeLimitId = undefined;
		planType = undefined;
		promoMessage = undefined;
		rateLimitReachedType = undefined;
		lastUpdatedAt = undefined;
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
		if (!isSupportedQuotaContext(ctx)) {
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
			const stale = isStale(window);
			const remaining = stale
				? "?"
				: `${formatPercent(remainingPercent(window))}%`;
			const reset = formatWindowReset(window, label);
			parts.push(
				ctx.ui.theme.fg("dim", `${label}:`) +
					ctx.ui.theme.fg(stale ? "dim" : severityColor(window), remaining) +
					(reset ? ctx.ui.theme.fg("dim", `↺${reset}`) : ""),
			);
		}
		if (parts.length === 0) {
			setStatus(ctx, undefined);
			return;
		}
		setStatus(ctx, parts.join(" "));
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
		if (update.rateLimitReachedType !== undefined) {
			const next = update.rateLimitReachedType ?? undefined;
			if (next !== rateLimitReachedType) {
				rateLimitReachedType = next;
				changed = true;
			}
		}
		if (!changed) return false;
		lastUpdatedAt = Date.now();
		renderStatus(ctx);
		return true;
	};

	const formatDetails = (providerName: string): string => {
		if (snapshots.size === 0 && !promoMessage && !rateLimitReachedType) {
			return `No ${providerName} quota data has been observed in response headers or SSE body events yet.`;
		}

		const lines = [
			`${providerName} quota${lastUpdatedAt ? ` (updated ${formatLocalDateTime(lastUpdatedAt)})` : ""}`,
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
			ctx.ui.notify(
				formatDetails("Codex"),
				snapshots.size > 0 ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("anthropic:usage", {
		description: "Show the latest Anthropic quota snapshot",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				formatDetails("Anthropic"),
				snapshots.size > 0 ? "info" : "warning",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearState();
		activeContext = isSupportedQuotaContext(ctx) ? ctx : undefined;
		setStatus(ctx, undefined);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		activeContext = undefined;
		setStatus(ctx, undefined);
	});
	pi.on("turn_start", (_event, ctx) => {
		activeContext = isSupportedQuotaContext(ctx) ? ctx : undefined;
		renderStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		clearState();
		activeContext = isSupportedQuotaContext(ctx) ? ctx : undefined;
		setStatus(ctx, undefined);
	});
	const handleResponseHeaders = (
		headers: Record<string, string>,
		ctx: ExtensionContext,
	): void => {
		if (!isSupportedQuotaContext(ctx)) return;
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

	return { handleResponseHeaders, handleBodyEvent };
}
