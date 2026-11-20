import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCodexProvider } from "./codex-provider.ts";

// ChatGPT-style inline citation: U+E200 "cite" (U+E202 "turnNsearchM")+ U+E201.
// The server rewrites these into `([host](url))` in final answers but leaves
// them raw in commentary, with a `url_citation` annotation spanning the marker.
const MARKER = /^\ue200cite(?:\ue202[^\ue200-\ue202]+)+\ue201$/;

type UrlCitation = { type?: unknown; start_index?: unknown; end_index?: unknown; url?: unknown };

function citationLink(url: string): string {
	return `[${new URL(url).hostname.replace(/^www\./, "")}](${url})`;
}

/**
 * Maps each citation marker in a completed Responses message item to the
 * Markdown links of the `url_citation` annotations spanning it. Annotation
 * indices count Unicode code points.
 */
export function citationReplacements(item: unknown): Map<string, string> {
	const replacements = new Map<string, string[]>();
	const message = item as { type?: unknown; content?: unknown } | undefined;
	if (message?.type !== "message" || !Array.isArray(message.content)) return new Map();

	for (const part of message.content as Array<{ text?: unknown; annotations?: unknown }>) {
		if (typeof part.text !== "string" || !Array.isArray(part.annotations)) continue;
		const chars = Array.from(part.text);
		for (const annotation of part.annotations as UrlCitation[]) {
			if (
				annotation.type !== "url_citation" ||
				typeof annotation.url !== "string" ||
				typeof annotation.start_index !== "number" ||
				typeof annotation.end_index !== "number"
			) continue;
			const marker = chars.slice(annotation.start_index, annotation.end_index).join("");
			if (!MARKER.test(marker)) continue;
			const links = replacements.get(marker) ?? [];
			const link = citationLink(annotation.url);
			if (!links.includes(link)) links.push(link);
			replacements.set(marker, links);
		}
	}
	return new Map([...replacements].map(([marker, links]) => [marker, `(${links.join(", ")})`]));
}

export function replaceCitationMarkers(text: string, replacements: Map<string, string>): string {
	let result = text;
	for (const [marker, link] of replacements) result = result.split(marker).join(link);
	return result;
}

/** Rewrites raw citation markers in Codex assistant messages into Markdown links. */
export function registerCodexCitationLinks(pi: ExtensionAPI): void {
	let replacements = new Map<string, string>();

	pi.on("provider_stream_event", (event) => {
		if (!isCodexProvider(event.provider)) return;
		const data = event.data as { type?: unknown; item?: unknown } | undefined;
		if (data?.type !== "response.output_item.done") return;
		for (const [marker, link] of citationReplacements(data.item)) replacements.set(marker, link);
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; content: Array<{ type?: string; text?: string }> };
		if (message.role !== "assistant" || replacements.size === 0) return;
		const current = replacements;
		replacements = new Map();
		return {
			message: {
				...event.message,
				content: message.content.map((block) =>
					block.type === "text" && typeof block.text === "string"
						? { ...block, text: replaceCitationMarkers(block.text, current) }
						: block,
				),
			} as typeof event.message,
		};
	});
}
