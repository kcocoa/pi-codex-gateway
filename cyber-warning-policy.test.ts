import { describe, expect, it } from "bun:test";
import {
	REPEATED_WARNING_LIMIT,
	serverModelWarningKey,
	shouldStopCyberWarning,
} from "./cyber-warning-policy.ts";

describe("Cyber warning policy", () => {
	it("only stops immediately for stop", () => {
		expect(shouldStopCyberWarning("warn", 1)).toBe(false);
		expect(shouldStopCyberWarning("stop", 1)).toBe(true);
	});

	it("stops on the configured repeated warned turn", () => {
		expect(
			shouldStopCyberWarning("stop-after-repeat", REPEATED_WARNING_LIMIT - 1),
		).toBe(false);
		expect(
			shouldStopCyberWarning("stop-after-repeat", REPEATED_WARNING_LIMIT),
		).toBe(true);
	});

	it("normalizes server-model warning keys for deduplication", () => {
		expect(serverModelWarningKey("GPT-5.4", "gpt-fallback")).toBe(
			"reroute:gpt-5.4:gpt-fallback",
		);
	});
});
