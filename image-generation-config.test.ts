import { describe, expect, it } from "bun:test";
import {
	externalImageGenerationEnabled,
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
