import { describe, expect, it } from "bun:test";
import {
	externalImageGenerationEnabled,
	externalImageGenerationOptions,
	hostedImageGenerationEnabled,
} from "./image-generation-config.ts";

describe("Image generation config", () => {
	it("keeps the local image_gen proxy opt-in", () => {
		expect(externalImageGenerationEnabled({})).toBe(false);
		expect(externalImageGenerationEnabled({ externalTools: {} })).toBe(false);
		expect(externalImageGenerationEnabled({ externalTools: { imageGeneration: false } })).toBe(false);
		expect(externalImageGenerationEnabled({ externalTools: { imageGeneration: true } })).toBe(true);
		expect(externalImageGenerationEnabled({ externalTools: null })).toBe(false);
	});

	it("keeps image_gen on Codex GPT models and defaults to GPT-6.2 Sol and GPT Image 2.6 Flare", () => {
		expect(externalImageGenerationOptions({})).toEqual({
			forOtherModels: false,
			promptModel: { provider: "codex-gateway", id: "gpt-6.2-sol" },
			imageModel: "gpt-image-2.6-flare",
		});
	});

	it("reads other-model exposure, prompt model, and image model", () => {
		expect(externalImageGenerationOptions({
			externalTools: {
				imageGeneration: true,
				imageGenerationForOtherModels: true,
				imagePromptModel: "codex-gateway/gpt-5.4",
				imageModel: "gpt-image-1",
			},
		})).toEqual({
			forOtherModels: true,
			promptModel: { provider: "codex-gateway", id: "gpt-5.4" },
			imageModel: "gpt-image-1",
		});
	});

	it("splits the prompt model at the first slash only", () => {
		expect(externalImageGenerationOptions({
			externalTools: { imagePromptModel: "codex-gateway/team/gpt-5.4" },
		}).promptModel).toEqual({ provider: "codex-gateway", id: "team/gpt-5.4" });
	});

	it("uses the default prompt model when the configured one has no provider", () => {
		expect(externalImageGenerationOptions({
			externalTools: { imagePromptModel: "gpt-5.4" },
		}).promptModel).toEqual({ provider: "codex-gateway", id: "gpt-6.2-sol" });
	});

	it("keeps the hosted image tool on by default", () => {
		expect(hostedImageGenerationEnabled({})).toBe(true);
		expect(hostedImageGenerationEnabled({ hostedTools: {} })).toBe(true);
		expect(hostedImageGenerationEnabled({ hostedTools: { imageGeneration: true } })).toBe(true);
	});

	it("disables the hosted image tool only by an explicit false", () => {
		expect(hostedImageGenerationEnabled({ hostedTools: { imageGeneration: false } })).toBe(false);
		expect(hostedImageGenerationEnabled({ hostedTools: null })).toBe(true);
		expect(hostedImageGenerationEnabled({ hostedTools: [] })).toBe(true);
		expect(hostedImageGenerationEnabled({ hostedTools: "off" })).toBe(true);
	});
});
