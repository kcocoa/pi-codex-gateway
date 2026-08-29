import { describe, expect, it, mock } from "bun:test";
import { registerQuotaDisplaySupport } from "./quota-display.ts";

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
