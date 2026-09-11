import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

mock.module("@earendil-works/pi-tui", () => ({
	Container: class { addChild() {} },
	Image: class {},
	Text: class {},
}));

const { registerHostedImageReception } = await import("./hosted-image-generation.ts");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const directories: string[] = [];

afterEach(async () => {
	for (const path of directories.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

type Handler = (event: unknown, ctx: unknown) => unknown;

describe("hosted image generation reception", () => {
	it("preserves server metadata and saves the completed result", async () => {
		const directory = await mkdtemp(join(import.meta.dir, ".hosted-image-test-"));
		directories.push(directory);
		const handlers = new Map<string, Handler[]>();
		const messages: Array<Record<string, unknown>> = [];
		const pi = {
			on(name: string, handler: Handler) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerMessageRenderer() {},
			sendMessage(message: Record<string, unknown>) {
				messages.push(message);
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: directory,
			sessionManager: {
			getSessionFile: () => join(directory, "session.jsonl"),
			getSessionDir: () => directory,
			getBranch: () => [{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "make a blue mug" }] },
			}],
			},
		} as unknown as ExtensionContext;
		const reception = registerHostedImageReception(pi);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		for (const handler of handlers.get("turn_start") ?? []) await handler({}, ctx);

		reception.handleProviderRequest({
			tools: [{ type: "image_generation" }],
		}, ctx);
		reception.handleBodyEvent({
			type: "response.created",
			response: {
				id: "resp_test",
				tools: [{
					type: "image_generation",
					background: "auto",
					output_format: "png",
					quality: "auto",
					size: "auto",
				}],
			},
		});
		reception.handleBodyEvent({
			type: "response.output_item.added",
			output_index: 1,
			item: { id: "ig_test", type: "image_generation_call", status: "in_progress" },
		});
		reception.handleBodyEvent({
			type: "response.image_generation_call.generating",
			item_id: "ig_test",
			output_index: 1,
		});
		reception.handleBodyEvent({
			type: "response.output_item.done",
			output_index: 1,
			item: {
				id: "ig_test",
				type: "image_generation_call",
				status: "completed",
				action: "generate",
				background: "opaque",
				output_format: "png",
				quality: "low",
				size: "1024x1024",
				revised_prompt: "A polished blue ceramic mug on white.",
				result: PNG,
			},
		});

		for (let index = 0; index < 20 && messages.length === 0; index++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(messages).toHaveLength(1);
		const details = messages[0].details as Record<string, unknown>;
		expect(details.source).toBe("hosted");
		expect(details.sourcePrompt).toBe("make a blue mug");
		expect(details.revisedPrompt).toBe("A polished blue ceramic mug on white.");
		expect(details.requestedParameters).toEqual({
			background: "auto",
			output_format: "png",
			quality: "auto",
			size: "auto",
		});
		expect(details.resolvedParameters).toEqual({
			action: "generate",
			background: "opaque",
			output_format: "png",
			quality: "low",
			size: "1024x1024",
		});
		expect(details.eventTypes).toEqual(expect.arrayContaining([
			"response.created",
			"response.output_item.added",
			"response.image_generation_call.generating",
			"response.output_item.done",
		]));
		const paths = details.paths as string[];
		expect(paths).toHaveLength(1);
		expect(await readFile(paths[0])).toEqual(Buffer.from(PNG, "base64"));
	});
});
