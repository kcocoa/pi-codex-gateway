import { describe, expect, it } from "bun:test";
import { CODEX_GATEWAY_ERROR_RESPONSE_EVENT } from "./codex-sse.ts";
import {
	formatWindowLabel,
	parseRateLimitHeaders,
	parseRateLimitStreamEvent,
	remainingPercent,
} from "./rate-limits.ts";

describe("Codex rate limits", () => {
	it("parses default and additional response-header families", () => {
		const update = parseRateLimitHeaders({
			"X-Codex-Primary-Used-Percent": "18.5",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1788030000",
			"x-codex-secondary-used-percent": "42",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": "1788548400",
			"x-codex-credits-has-credits": "true",
			"x-codex-credits-unlimited": "0",
			"x-codex-credits-balance": "12.50",
			"x-codex-other-primary-used-percent": "75",
			"x-codex-other-primary-window-minutes": "60",
			"x-codex-other-limit-name": "Code review",
			"x-codex-active-limit": "codex_other",
			"x-codex-promo-message": "Upgrade for more usage",
			"x-codex-rate-limit-reached-type": "weekly_limit",
		});

		expect(update?.activeLimitId).toBe("codex_other");
		expect(update?.promoMessage).toBe("Upgrade for more usage");
		expect(update?.rateLimitReachedType).toBe("weekly_limit");
		expect(update?.snapshots).toHaveLength(2);
		expect(update?.snapshots[0]).toMatchObject({
			limitId: "codex",
			primary: { usedPercent: 18.5, windowMinutes: 300, resetsAt: 1788030000 },
			secondary: {
				usedPercent: 42,
				windowMinutes: 10080,
				resetsAt: 1788548400,
			},
			credits: { hasCredits: true, unlimited: false, balance: "12.50" },
		});
		expect(update?.snapshots[1]).toMatchObject({
			limitId: "codex_other",
			limitName: "Code review",
			primary: { usedPercent: 75, windowMinutes: 60 },
		});
	});

	it("ignores responses with no Codex quota headers", () => {
		expect(
			parseRateLimitHeaders({ "retry-after": "10", "x-request-id": "req_1" }),
		).toBeUndefined();
	});

	it("requires finite used percentages and complete credit booleans", () => {
		const update = parseRateLimitHeaders({
			"x-codex-primary-used-percent": "NaN",
			"x-codex-credits-has-credits": "true",
		});
		expect(update?.snapshots).toEqual([{ limitId: "codex" }]);
	});

	it("parses quota headers captured from failed provider responses", () => {
		expect(
			parseRateLimitStreamEvent({
				type: CODEX_GATEWAY_ERROR_RESPONSE_EVENT,
				status: 429,
				headers: {
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-promo-message": "Try another model",
				},
			}),
		).toMatchObject({
			promoMessage: "Try another model",
			snapshots: [
				{
					limitId: "codex",
					primary: { usedPercent: 100, windowMinutes: 300 },
				},
			],
		});
	});

	it("parses optional codex.rate_limits stream events", () => {
		expect(
			parseRateLimitStreamEvent({
				type: "codex.rate_limits",
				plan_type: "plus",
				metered_limit_name: "codex-code-review",
				rate_limits: {
					primary: {
						used_percent: 12.5,
						window_minutes: 300,
						reset_at: 1788030000,
					},
					secondary: null,
				},
				credits: { has_credits: true, unlimited: false, balance: "4.25" },
			}),
		).toEqual({
			snapshots: [
				{
					limitId: "codex_code_review",
					primary: {
						usedPercent: 12.5,
						windowMinutes: 300,
						resetsAt: 1788030000,
					},
					secondary: undefined,
					credits: { hasCredits: true, unlimited: false, balance: "4.25" },
					planType: "plus",
				},
			],
		});
	});

	it("formats common windows and clamps remaining percentages", () => {
		expect(
			formatWindowLabel({ usedPercent: 10, windowMinutes: 300 }, "primary"),
		).toBe("5h");
		expect(
			formatWindowLabel({ usedPercent: 10, windowMinutes: 10080 }, "secondary"),
		).toBe("7d");
		expect(remainingPercent({ usedPercent: 12.5 })).toBe(87.5);
		expect(remainingPercent({ usedPercent: 120 })).toBe(0);
	});
});
