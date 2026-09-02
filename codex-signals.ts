import type { SseBodyEvent } from "./codex-sse.ts";

const TRUSTED_ACCESS_FOR_CYBER = "trusted_access_for_cyber";
const METADATA_EVENT_TYPES = new Set([
	"response.metadata",
	"codex.response.metadata",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function jsonValueAsString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return jsonValueAsString(value[0]);
	return undefined;
}

function modelFromJsonHeaders(value: unknown): string | undefined {
	const headers = asRecord(value);
	if (!headers) return undefined;
	for (const [name, headerValue] of Object.entries(headers)) {
		if (
			name.toLowerCase() === "openai-model" ||
			name.toLowerCase() === "x-openai-model"
		) {
			return jsonValueAsString(headerValue);
		}
	}
	return undefined;
}

export function getResponseHeader(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	const expected = name.toLowerCase();
	for (const [headerName, value] of Object.entries(headers)) {
		if (headerName.toLowerCase() === expected) return value;
	}
	return undefined;
}

export function getServerModelFromResponseHeaders(
	headers: Record<string, string>,
): string | undefined {
	return (
		getResponseHeader(headers, "openai-model") ??
		getResponseHeader(headers, "x-openai-model")
	);
}

export function getServerModelFromBodyEvent(
	event: SseBodyEvent,
): string | undefined {
	const response = asRecord(event.response);
	return (
		modelFromJsonHeaders(response?.headers) ??
		modelFromJsonHeaders(event.headers)
	);
}

export function hasTrustedAccessForCyberRecommendation(
	event: SseBodyEvent,
): boolean {
	if (typeof event.type !== "string" || !METADATA_EVENT_TYPES.has(event.type))
		return false;
	const metadata = asRecord(event.metadata);
	const recommendations = metadata?.openai_verification_recommendation;
	return (
		Array.isArray(recommendations) &&
		recommendations.includes(TRUSTED_ACCESS_FOR_CYBER)
	);
}
