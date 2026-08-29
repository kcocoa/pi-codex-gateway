import { describe, expect, it } from "bun:test";
import {
	getResponseHeader,
	getServerModelFromResponseHeaders,
	getServerModelFromStreamEvent,
	hasTrustedAccessForCyberRecommendation,
} from "./codex-signals.ts";

describe("Codex cyber signals", () => {
	it("reads response headers case-insensitively", () => {
		const headers = { "OpenAI-Model": "gpt-fallback" };
		expect(getResponseHeader(headers, "openai-model")).toBe("gpt-fallback");
		expect(getServerModelFromResponseHeaders(headers)).toBe("gpt-fallback");
	});

	it("prefers response headers over top-level stream headers", () => {
		expect(getServerModelFromStreamEvent({
			type: "response.completed",
			response: { headers: { "x-openai-model": ["gpt-response"] } },
			headers: { "openai-model": "gpt-top-level" },
		})).toBe("gpt-response");
	});

	it("recognizes trusted-access recommendations from both metadata event names", () => {
		for (const type of ["response.metadata", "codex.response.metadata"]) {
			expect(hasTrustedAccessForCyberRecommendation({
				type,
				metadata: {
					openai_verification_recommendation: ["unknown", "trusted_access_for_cyber"],
				},
			})).toBe(true);
		}
	});

	it("ignores missing, malformed, and unrelated recommendations", () => {
		expect(hasTrustedAccessForCyberRecommendation({
			type: "response.metadata",
			metadata: { openai_verification_recommendation: "trusted_access_for_cyber" },
		})).toBe(false);
		expect(hasTrustedAccessForCyberRecommendation({
			type: "response.completed",
			metadata: { openai_verification_recommendation: ["trusted_access_for_cyber"] },
		})).toBe(false);
	});
});
