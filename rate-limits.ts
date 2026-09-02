import type { SseBodyEvent } from "./codex-sse.ts";

export interface RateLimitWindow {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
}

export interface CreditsSnapshot {
	hasCredits: boolean;
	unlimited: boolean;
	balance?: string;
}

export interface RateLimitSnapshot {
	limitId: string;
	limitName?: string;
	primary?: RateLimitWindow;
	secondary?: RateLimitWindow;
	credits?: CreditsSnapshot;
	planType?: string;
}

export type RateLimitUpdateSource = "response_headers" | "sse_body_event";

export interface RateLimitUpdate {
	source: RateLimitUpdateSource;
	snapshots: RateLimitSnapshot[];
	activeLimitId?: string;
	promoMessage?: string;
	rateLimitReachedType?: string;
}

function normalizeLimitId(value: string): string {
	return value.trim().toLowerCase().replaceAll("-", "_");
}

function headerPrefix(limitId: string): string {
	return `x-${limitId.replaceAll("_", "-")}`;
}

function normalizedHeaders(
	headers: Record<string, string>,
): Map<string, string> {
	return new Map(
		Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
	);
}

function trimmed(value: string | undefined): string | undefined {
	const result = value?.trim();
	return result ? result : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function integer(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	if (value === "1" || value.toLowerCase() === "true") return true;
	if (value === "0" || value.toLowerCase() === "false") return false;
	return undefined;
}

function parseHeaderWindow(
	headers: Map<string, string>,
	usedPercentHeader: string,
	windowMinutesHeader: string,
	resetAtHeader: string,
): RateLimitWindow | undefined {
	const usedPercent = finiteNumber(headers.get(usedPercentHeader));
	if (usedPercent === undefined) return undefined;
	const windowMinutes = integer(headers.get(windowMinutesHeader));
	const resetsAt = integer(headers.get(resetAtHeader));
	// Some gateways send a bare 0% placeholder when the window does not
	// exist (no duration, no reset time). Filter it instead of rendering
	// a meaningless "secondary:100%".
	if (usedPercent === 0 && !windowMinutes && resetsAt === undefined) {
		return undefined;
	}
	return { usedPercent, windowMinutes, resetsAt };
}

function parseCredits(
	headers: Map<string, string>,
): CreditsSnapshot | undefined {
	const hasCredits = booleanValue(headers.get("x-codex-credits-has-credits"));
	const unlimited = booleanValue(headers.get("x-codex-credits-unlimited"));
	if (hasCredits === undefined || unlimited === undefined) return undefined;
	return {
		hasCredits,
		unlimited,
		balance: trimmed(headers.get("x-codex-credits-balance")),
	};
}

function parseHeaderSnapshot(
	headers: Map<string, string>,
	limitId: string,
	credits: CreditsSnapshot | undefined,
	planType: string | undefined,
): RateLimitSnapshot {
	const prefix = headerPrefix(limitId);
	return {
		limitId,
		limitName: trimmed(headers.get(`${prefix}-limit-name`)),
		primary: parseHeaderWindow(
			headers,
			`${prefix}-primary-used-percent`,
			`${prefix}-primary-window-minutes`,
			`${prefix}-primary-reset-at`,
		),
		secondary: parseHeaderWindow(
			headers,
			`${prefix}-secondary-used-percent`,
			`${prefix}-secondary-window-minutes`,
			`${prefix}-secondary-reset-at`,
		),
		credits,
		planType,
	};
}

function hasSnapshotData(snapshot: RateLimitSnapshot): boolean {
	return (
		snapshot.primary !== undefined ||
		snapshot.secondary !== undefined ||
		snapshot.credits !== undefined ||
		snapshot.limitName !== undefined ||
		snapshot.planType !== undefined
	);
}

export function parseRateLimitHeaders(
	headers: Record<string, string>,
): RateLimitUpdate | undefined {
	const normalized = normalizedHeaders(headers);
	const limitIds = new Set<string>();
	let sawRateLimitHeader = false;

	for (const name of normalized.keys()) {
		const match = /^x-(.+)-(?:primary|secondary)-used-percent$/.exec(name);
		if (match) {
			limitIds.add(normalizeLimitId(match[1]));
			sawRateLimitHeader = true;
		}
		if (
			name === "x-codex-active-limit" ||
			name === "x-codex-plan-type" ||
			name === "x-codex-promo-message" ||
			name === "x-codex-rate-limit-reached-type" ||
			name.startsWith("x-codex-credits-") ||
			/^x-.+-limit-name$/.test(name)
		) {
			sawRateLimitHeader = true;
		}
	}
	if (!sawRateLimitHeader) return undefined;

	const activeLimitId = trimmed(normalized.get("x-codex-active-limit"));
	if (activeLimitId) limitIds.add(normalizeLimitId(activeLimitId));
	if ([...normalized.keys()].some((name) => name.startsWith("x-codex-")))
		limitIds.add("codex");

	const credits = parseCredits(normalized);
	const planType = trimmed(normalized.get("x-codex-plan-type"));
	const snapshots = [...limitIds]
		.sort()
		.map((limitId) =>
			parseHeaderSnapshot(normalized, limitId, credits, planType),
		)
		.filter(
			(snapshot) => snapshot.limitId === "codex" || hasSnapshotData(snapshot),
		);

	return {
		source: "response_headers",
		snapshots,
		activeLimitId: activeLimitId ? normalizeLimitId(activeLimitId) : undefined,
		promoMessage: trimmed(normalized.get("x-codex-promo-message")),
		rateLimitReachedType: trimmed(
			normalized.get("x-codex-rate-limit-reached-type"),
		),
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseEventWindow(value: unknown): RateLimitWindow | undefined {
	const window = asRecord(value);
	if (!window) return undefined;
	const usedPercent = finiteNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	return {
		usedPercent,
		windowMinutes: integer(window.window_minutes),
		resetsAt: integer(window.reset_at),
	};
}

function parseEventCredits(value: unknown): CreditsSnapshot | undefined {
	const credits = asRecord(value);
	if (!credits) return undefined;
	const hasCredits = booleanValue(credits.has_credits);
	const unlimited = booleanValue(credits.unlimited);
	if (hasCredits === undefined || unlimited === undefined) return undefined;
	return {
		hasCredits,
		unlimited,
		balance:
			typeof credits.balance === "string"
				? trimmed(credits.balance)
				: undefined,
	};
}

export function parseRateLimitBodyEvent(
	event: SseBodyEvent,
): RateLimitUpdate | undefined {
	if (event.type !== "codex.rate_limits") return undefined;
	const limits = asRecord(event.rate_limits);
	const rawLimitId =
		typeof event.metered_limit_name === "string"
			? event.metered_limit_name
			: typeof event.limit_name === "string"
				? event.limit_name
				: "codex";
	const limitId = normalizeLimitId(rawLimitId) || "codex";
	const snapshot: RateLimitSnapshot = {
		limitId,
		primary: parseEventWindow(limits?.primary),
		secondary: parseEventWindow(limits?.secondary),
		credits: parseEventCredits(event.credits),
		planType:
			typeof event.plan_type === "string"
				? trimmed(event.plan_type)
				: undefined,
	};
	return { source: "sse_body_event", snapshots: [snapshot] };
}

export function remainingPercent(window: RateLimitWindow): number {
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function formatWindowLabel(
	window: RateLimitWindow,
	fallback: string,
): string {
	const minutes = window.windowMinutes;
	if (!minutes || minutes <= 0) return fallback;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}
