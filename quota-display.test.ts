import { describe, expect, it, mock } from "bun:test";
import {
	formatResetCountdown,
	formatSubscriptionType,
	registerQuotaDisplaySupport,
} from "./quota-display.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
	} as unknown as Parameters<typeof registerQuotaDisplaySupport>[0];
	return {
		pi,
		commands,
		async emit(name: string, event: unknown, ctx: unknown) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function createContext(provider = "codex-gateway") {
	const setStatus = mock(() => undefined);
	const notify = mock(() => undefined);
	return {
		ctx: {
			model: {
				provider,
				id: provider === "anthropic" ? "claude-opus" : "gpt-5.4",
			},
			hasUI: true,
			ui: {
				setStatus,
				notify,
				theme: { fg: (_color: string, text: string) => text },
			},
		},
		setStatus,
		notify,
	};
}

describe("Codex quota display", () => {
	it("normalizes supported subscription types", () => {
		expect(formatSubscriptionType("plus")).toBe("plus");
		expect(formatSubscriptionType("prolite")).toBe("pro5x");
		expect(formatSubscriptionType("pro")).toBe("pro20x");
		expect(formatSubscriptionType("team")).toBe("business");
		expect(formatSubscriptionType("business")).toBe("business");
		expect(formatSubscriptionType("self_serve_business_prolite")).toBe(
			"business pro",
		);
	});

	it("formats reset countdowns with at most two units", () => {
		const now = Date.UTC(2026, 7, 29, 12, 0, 0);
		expect(
			formatResetCountdown(
				(now + (5 * 86_400 + 17 * 3_600 + 42 * 60) * 1000) / 1000,
				now,
			),
		).toBe("5d17h");
		expect(
			formatResetCountdown(
				(now + (3 * 3_600 + 44 * 60 + 20) * 1000) / 1000,
				now,
			),
		).toBe("3h44m");
	});

	it("renders remaining quota from response headers in the footer", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		await harness.emit("session_start", { type: "session_start" }, ctx);
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "20",
					"x-codex-primary-window-minutes": "300",
					"x-codex-secondary-used-percent": "50",
					"x-codex-secondary-window-minutes": "10080",
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			"codex-quota",
			"5h:80% 7d:50%",
		]);
	});

	it("renders quota headers for the official OpenAI Codex provider", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext("openai-codex");
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "25",
					"x-codex-primary-window-minutes": "300",
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			"codex-quota",
			"5h:75%",
		]);
	});

	it("shows the subscription and compact reset countdowns", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext("openai-codex");
		const now = Math.ceil(Date.now() / 1000);
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-plan-type": "prolite",
					"x-codex-primary-used-percent": "25",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": String(
						now + 3 * 3_600 + 44 * 60 + 20,
					),
					"x-codex-secondary-used-percent": "50",
					"x-codex-secondary-window-minutes": "10080",
					"x-codex-secondary-reset-at": String(
						now + 5 * 86_400 + 17 * 3_600 + 42 * 60,
					),
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			"codex-quota",
			"pro5x 5h:75%↺3h44m 7d:50%↺5d17h",
		]);
	});

	it("ignores credit-only active buckets in the compact footer", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext("openai-codex");
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "20",
					"x-codex-primary-window-minutes": "300",
					"x-codex-active-limit": "premium",
					"x-codex-credits-has-credits": "false",
					"x-codex-credits-unlimited": "false",
					"x-codex-credits-balance": "0",
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			"codex-quota",
			"5h:80%",
		]);
	});

	it("hides credit balances when no rate-limit windows are available", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext("openai-codex");
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-active-limit": "premium",
					"x-codex-credits-has-credits": "false",
					"x-codex-credits-unlimited": "false",
					"x-codex-credits-balance": "0",
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			"codex-quota",
			undefined,
		]);
	});

	it("accepts optional codex.rate_limits stream events", async () => {
		const harness = createHarness();
		const support = registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		await harness.emit("turn_start", { type: "turn_start" }, ctx);
		support.handleStreamEvent({
			type: "codex.rate_limits",
			rate_limits: { primary: { used_percent: 30, window_minutes: 60 } },
		});

		expect(setStatus.mock.calls.at(-1)).toEqual([
			"codex-quota",
			"1h:70%",
		]);
	});

	it("clears its footer status when another provider is selected", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const active = createContext();
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "10",
					"x-codex-primary-window-minutes": "300",
				},
			},
			active.ctx,
		);
		const other = createContext("anthropic");
		await harness.emit("model_select", { type: "model_select" }, other.ctx);

		expect(other.setStatus.mock.calls.at(-1)).toEqual([
			"codex-quota",
			undefined,
		]);
	});

	it("clears stale quota when switching between Codex providers", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const gateway = createContext();
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "10",
					"x-codex-primary-window-minutes": "300",
				},
			},
			gateway.ctx,
		);
		const official = createContext("openai-codex");
		await harness.emit("model_select", { type: "model_select" }, official.ctx);
		await harness.commands.get("codex:usage")?.handler("", official.ctx);

		expect(official.notify.mock.calls.at(-1)?.[0]).toContain(
			"No Codex quota data",
		);
	});

	it("registers a detailed usage command", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, notify } = createContext();
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "20",
					"x-codex-primary-window-minutes": "300",
					"x-codex-credits-has-credits": "true",
					"x-codex-credits-unlimited": "false",
					"x-codex-credits-balance": "7.50",
				},
			},
			ctx,
		);
		await harness.commands.get("codex:usage")?.handler("", ctx);

		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Primary (5h): 20% used, 80% left",
		);
		expect(notify.mock.calls.at(-1)?.[0]).toContain("balance=7.50");
	});
});
