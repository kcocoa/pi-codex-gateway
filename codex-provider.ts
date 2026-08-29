import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CODEX_GATEWAY_PROVIDER_ID = "codex-gateway";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export function isCodexProvider(provider: string | undefined): boolean {
	return (
		provider === CODEX_GATEWAY_PROVIDER_ID ||
		provider === OPENAI_CODEX_PROVIDER_ID
	);
}

export function isCodexGpt(ctx: Pick<ExtensionContext, "model">): boolean {
	return (
		isCodexProvider(ctx.model?.provider) && /^gpt-/i.test(ctx.model?.id ?? "")
	);
}

export function isOpenAICodexGpt(
	ctx: Pick<ExtensionContext, "model">,
): boolean {
	return (
		ctx.model?.provider === OPENAI_CODEX_PROVIDER_ID &&
		/^gpt-/i.test(ctx.model.id)
	);
}

export function codexProviderLabel(provider: string | undefined): string {
	return provider === OPENAI_CODEX_PROVIDER_ID
		? "OpenAI Codex"
		: "Codex Gateway";
}
