import { describe, expect, it, mock } from "bun:test";
import {
	anthropicFallbackModel,
	registerAnthropicFallbackNotice,
} from "./anthropic-fallback.ts";

type Handler = (...args: unknown[]) => unknown;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as Parameters<typeof registerAnthropicFallbackNotice>[0];
	const notify = mock((_message: string, _level?: string) => undefined);
	const ctx = { hasUI: true, ui: { notify } };
	return {
		pi,
		notify,
		async emit(name: string, event: unknown) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

const fallbackMessage = {
	role: "assistant",
	provider: "anthropic",
	model: "claude-fable-5",
	responseModel: "claude-opus-4-8",
};

describe("Anthropic fallback notice", () => {
	it("detects only Anthropic assistant messages with a different response model", () => {
		expect(anthropicFallbackModel(fallbackMessage)).toBe("claude-opus-4-8");
		expect(
			anthropicFallbackModel({ ...fallbackMessage, responseModel: undefined }),
		).toBeUndefined();
		expect(
			anthropicFallbackModel({
				...fallbackMessage,
				responseModel: "claude-fable-5",
			}),
		).toBeUndefined();
		expect(
			anthropicFallbackModel({ ...fallbackMessage, provider: "openrouter" }),
		).toBeUndefined();
		expect(
			anthropicFallbackModel({ ...fallbackMessage, role: "user" }),
		).toBeUndefined();
	});

	it("warns once per fallback pair until the model or session changes", async () => {
		const harness = createHarness();
		registerAnthropicFallbackNotice(harness.pi);
		const end = { type: "message_end", message: fallbackMessage };

		await harness.emit("message_end", end);
		await harness.emit("message_end", end);
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(harness.notify.mock.calls[0]).toEqual([
			"Anthropic answered with claude-opus-4-8 instead of claude-fable-5 (server-side fallback).",
			"warning",
		]);

		await harness.emit("model_select", { type: "model_select" });
		await harness.emit("message_end", end);
		expect(harness.notify).toHaveBeenCalledTimes(2);
	});
});
