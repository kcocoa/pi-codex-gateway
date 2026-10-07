import { describe, expect, it } from "bun:test";
import {
	codexProviderLabel,
	isAnthropic,
	isAnthropicProvider,
	isCodexGpt,
	isOpenAICodexGpt,
} from "./codex-provider.ts";

function context(provider: string, id = "gpt-5.4") {
	return { model: { provider, id } } as Parameters<typeof isCodexGpt>[0];
}

describe("Codex provider matching", () => {
	it("accepts GPT models from both Codex providers", () => {
		expect(isCodexGpt(context("codex-gateway"))).toBe(true);
		expect(isCodexGpt(context("openai-codex"))).toBe(true);
		expect(isCodexGpt(context("anthropic", "claude-opus"))).toBe(false);
	});

	it("matches the official provider and labels both providers", () => {
		expect(isOpenAICodexGpt(context("openai-codex"))).toBe(true);
		expect(codexProviderLabel("codex-gateway")).toBe("Codex Gateway");
		expect(codexProviderLabel("openai-codex")).toBe("OpenAI Codex");
	});

	it("identifies Anthropic provider and context", () => {
		expect(isAnthropicProvider("anthropic")).toBe(true);
		expect(isAnthropicProvider("codex-gateway")).toBe(false);
		expect(isAnthropic(context("anthropic", "claude-sonnet-4-5"))).toBe(true);
		expect(isAnthropic(context("openai-codex"))).toBe(false);
	});
});
