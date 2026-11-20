import { describe, expect, it } from "bun:test";
import {
	citationReplacements,
	registerCodexCitationLinks,
	replaceCitationMarkers,
} from "./codex-citations.ts";

const marker = "\ue200cite\ue202turn1view0\ue201";
const prefix = "Found the reference picture.";
const url = "https://img.example.com/ref.png";

// Shape of a commentary item from codex-gateway: the annotation spans exactly
// the raw marker, with indices in code points.
function commentaryItem(text: string, annotations: unknown[]) {
	return {
		type: "message",
		phase: "commentary",
		role: "assistant",
		content: [{ type: "output_text", text, annotations }],
	};
}

function citation(start: number, end: number, citedUrl: string) {
	return { type: "url_citation", start_index: start, end_index: end, title: "", url: citedUrl };
}

function citationAfter(before: string, citedUrl: string) {
	const start = Array.from(before).length;
	return citation(start, start + Array.from(marker).length, citedUrl);
}

describe("Codex citation links", () => {
	it("maps a marker to a Markdown link labelled with the cited host", () => {
		const item = commentaryItem(prefix + marker, [citationAfter(prefix, url)]);
		expect(citationReplacements(item)).toEqual(new Map([[marker, `([img.example.com](${url}))`]]));
	});

	it("drops www. from the label like the server's final answers", () => {
		const wwwUrl = "https://www.example.org/a.html";
		const item = commentaryItem(marker, [citationAfter("", wwwUrl)]);
		expect(citationReplacements(item).get(marker)).toBe(`([example.org](${wwwUrl}))`);
	});

	it("counts annotation indices in code points", () => {
		const item = commentaryItem(`😀${marker}`, [citation(1, 1 + Array.from(marker).length, url)]);
		expect(citationReplacements(item).has(marker)).toBe(true);
	});

	it("joins several sources cited by one marker", () => {
		const both = "\ue200cite\ue202turn1search0\ue202turn2view0\ue201";
		const item = commentaryItem(both, [
			citation(0, both.length, "https://a.example/1"),
			citation(0, both.length, "https://b.example/2"),
		]);
		expect(citationReplacements(item).get(both)).toBe(
			"([a.example](https://a.example/1), [b.example](https://b.example/2))",
		);
	});

	it("ignores annotations over text that is already a link", () => {
		const text = "Source. ([example.org](https://example.org/))";
		const item = commentaryItem(text, [citation(8, text.length, "https://example.org/")]);
		expect(citationReplacements(item).size).toBe(0);
	});

	it("replaces every occurrence of a marker", () => {
		const replacements = new Map([[marker, "([x.org](https://x.org/))"]]);
		expect(replaceCitationMarkers(`a${marker}b${marker}`, replacements)).toBe(
			"a([x.org](https://x.org/))b([x.org](https://x.org/))",
		);
	});

	it("rewrites the finalized Codex assistant message", async () => {
		const handlers = new Map<string, (event: unknown) => unknown>();
		const pi = {
			on(name: string, handler: (event: unknown) => unknown) {
				handlers.set(name, handler);
			},
		} as unknown as Parameters<typeof registerCodexCitationLinks>[0];
		registerCodexCitationLinks(pi);

		await handlers.get("provider_stream_event")!({
			provider: "codex-gateway",
			data: {
				type: "response.output_item.done",
				item: commentaryItem(prefix + marker, [citationAfter(prefix, url)]),
			},
		});
		const result = await handlers.get("message_end")!({
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: prefix + marker },
					{ type: "toolCall", id: "call_1", name: "imagegen", arguments: {} },
				],
			},
		}) as { message: { content: unknown[] } };

		expect(result.message.content).toEqual([
			{ type: "text", text: `${prefix}([img.example.com](${url}))` },
			{ type: "toolCall", id: "call_1", name: "imagegen", arguments: {} },
		]);
	});
});
