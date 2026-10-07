import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isAnthropicProvider } from "./codex-provider.ts";

interface AssistantLike {
	role?: string;
	provider?: string;
	model?: string;
	responseModel?: string;
}

/** Returns the model that actually answered when Anthropic fell back server-side. */
export function anthropicFallbackModel(message: unknown): string | undefined {
	const m = message as AssistantLike | undefined;
	if (m?.role !== "assistant" || !isAnthropicProvider(m.provider))
		return undefined;
	if (!m.responseModel || m.responseModel === m.model) return undefined;
	return m.responseModel;
}

/**
 * Read-only notice for Anthropic server-side model fallback. Pi records the
 * answering model as `responseModel` but does not show it; this warns once per
 * selected/answering model pair until the session or model changes.
 */
export function registerAnthropicFallbackNotice(pi: ExtensionAPI): void {
	let lastNotified: string | undefined;
	const reset = (): void => {
		lastNotified = undefined;
	};

	pi.on("session_start", reset);
	pi.on("model_select", reset);
	pi.on("message_end", (event, ctx: ExtensionContext) => {
		const message = event.message as AssistantLike;
		const fallback = anthropicFallbackModel(message);
		if (!fallback || !ctx.hasUI) return;
		const key = `${message.model}->${fallback}`;
		if (key === lastNotified) return;
		lastNotified = key;
		ctx.ui.notify(
			`Anthropic answered with ${fallback} instead of ${message.model} (server-side fallback).`,
			"warning",
		);
	});
}
