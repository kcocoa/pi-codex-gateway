import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import type { SseBodyEvent, SseBodyEventHandler } from "./codex-sse.ts";

const HOSTED_IMAGE_MESSAGE = "codex-hosted-image";
const IMAGE_PARAMETER_KEYS = [
	"action",
	"background",
	"output_format",
	"quality",
	"size",
] as const;

type HostedImageParameters = Record<string, unknown>;

type HostedRequestState = {
	responseId: string;
	sourcePrompt?: string;
	requestedParameters: HostedImageParameters;
	eventTypes: Set<string>;
	partialImages: number;
};

type HostedImageState = {
	id: string;
	responseId?: string;
	outputIndex?: number;
	item: Record<string, unknown>;
	eventTypes: Set<string>;
	partialImages: number;
};

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function uniqueOutputPath(path: string): Promise<string> {
	if (!(await exists(path))) return path;

	const extension = extname(path);
	const stem = path.slice(0, path.length - extension.length);
	for (let index = 2; index < 10_000; index++) {
		const candidate = `${stem}-${index}${extension}`;
		if (!(await exists(candidate))) return candidate;
	}
	throw new Error(`Unable to find an unused output path near ${path}`);
}

function outputPathFor(ctx: ExtensionContext, mimeType: string): string {
	const extension = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
	const directory = ctx.sessionManager.getSessionFile() === undefined
		? "/tmp/generated_images"
		: join(ctx.sessionManager.getSessionDir(), "generated_images");
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(directory, `${timestamp}-image${extension}`);
}

function decodeHostedImage(result: string): { data: string; mimeType: string } {
	const dataUrl = result.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
	const data = dataUrl ? dataUrl[2] : result;
	const bytes = Buffer.from(data, "base64");
	if (!data || bytes.toString("base64") !== data) throw new Error("Invalid image base64");

	const format = bytes.length >= 8 && bytes.subarray(0, 8).equals(
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	)
		? "png"
		: bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
			? "jpeg"
			: bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
				? "webp"
				: undefined;
	if (!format) throw new Error("Unsupported image format (expected PNG, JPEG, or WebP)");
	return { data, mimeType: `image/${format}` };
}

async function saveHostedImage(
	ctx: ExtensionContext,
	output: { data: string; mimeType: string },
): Promise<string> {
	const path = await uniqueOutputPath(outputPathFor(ctx, output.mimeType));
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, Buffer.from(output.data, "base64"));
	return path;
}

function parametersFrom(value: unknown): HostedImageParameters {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		IMAGE_PARAMETER_KEYS
			.filter((key) => record[key] !== undefined)
			.map((key) => [key, record[key]]),
	);
}

function latestUserPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } =>
				!!part && typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

function responseRecord(event: SseBodyEvent): Record<string, unknown> | undefined {
	return event.response && typeof event.response === "object" && !Array.isArray(event.response)
		? event.response as Record<string, unknown>
		: undefined;
}

function itemRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function imageItemId(item: Record<string, unknown>): string | undefined {
	return typeof item.id === "string" ? item.id : undefined;
}

export type HostedImageReception = {
	handleBodyEvent: SseBodyEventHandler;
	handleProviderRequest(payload: Record<string, unknown>, ctx: ExtensionContext): void;
};

export function registerHostedImageReception(pi: ExtensionAPI): HostedImageReception {
	let ctx: ExtensionContext | undefined;
	let pendingRequest: Omit<HostedRequestState, "responseId"> | undefined;
	let activeResponseId: string | undefined;
	const requests = new Map<string, HostedRequestState>();
	const images = new Map<string, HostedImageState>();
	const saved = new Set<string>();

	pi.on("session_start", (_event, next) => {
		ctx = next;
	});
	pi.on("turn_start", (_event, next) => {
		ctx = next;
		pendingRequest = undefined;
		activeResponseId = undefined;
		requests.clear();
		images.clear();
		saved.clear();
	});

	pi.registerMessageRenderer(HOSTED_IMAGE_MESSAGE, (message, { outputPad }, theme) => {
		const container = new Container();
		const content = typeof message.content === "string"
			? [{ type: "text" as const, text: message.content }]
			: message.content;
		for (const part of content) {
			if (part.type === "text") {
				container.addChild(new Text(part.text, outputPad, 0));
			} else if (part.type === "image") {
				try {
					container.addChild(new Image(part.data, part.mimeType, {
						fallbackColor: (text) => theme.fg("dim", text),
					}));
				} catch {
					container.addChild(new Text(
						"Image preview unavailable; use the saved path above.",
						outputPad,
						0,
					));
				}
			}
		}
		return container;
	});

	const sendMessageSafely = (message: Parameters<ExtensionAPI["sendMessage"]>[0]): void => {
		try {
			pi.sendMessage(message, { triggerTurn: false });
		} catch {
			// The response may finish while asynchronous image persistence is still
			// completing. A stale Pi context must not turn a successful save into a
			// failed provider request.
		}
	};

	const saveImageItem = (item: Record<string, unknown>, outputIndex?: number): void => {
		if (!ctx || typeof item.result !== "string" || !item.result) return;
		const id = imageItemId(item) ?? `index:${String(outputIndex)}`;
		if (saved.has(id)) return;
		saved.add(id);

		const responseId = activeResponseId;
		const imageState = images.get(id);
		const request = imageState?.responseId
			? requests.get(imageState.responseId)
			: responseId
				? requests.get(responseId)
				: undefined;
		const current = ctx;
		const eventTypes = new Set([
			...(request?.eventTypes ?? []),
			...(imageState?.eventTypes ?? []),
			"response.output_item.done",
		]);
		const partialImages = (request?.partialImages ?? 0) + (imageState?.partialImages ?? 0);
		const resolvedParameters = parametersFrom(item);
		const requestedParameters = request?.requestedParameters ?? {};
		const sourcePrompt = request?.sourcePrompt;
		const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;

		void (async () => {
			try {
				const output = decodeHostedImage(item.result as string);
				const path = await saveHostedImage(current, output);
				const metadata = {
					source: "hosted",
					itemId: typeof item.id === "string" ? item.id : undefined,
					responseId: imageState?.responseId ?? responseId,
					sourcePrompt,
					revisedPrompt,
					requestedParameters,
					resolvedParameters,
					partialImages,
					eventTypes: [...eventTypes],
					paths: [path],
				};
				const summary = [
					`Received hosted image:\n${path}`,
					revisedPrompt ? `Server revised prompt:\n${revisedPrompt}` : undefined,
				].filter(Boolean).join("\n\n");
				sendMessageSafely({
					customType: HOSTED_IMAGE_MESSAGE,
					content: [
						{ type: "text", text: summary },
						{ type: "image", data: output.data, mimeType: output.mimeType },
					],
					display: true,
					details: metadata,
				});
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				sendMessageSafely({
					customType: HOSTED_IMAGE_MESSAGE,
					content: [{ type: "text", text: `Image reception failed: ${text}` }],
					display: true,
					details: { source: "hosted", paths: [], error: true },
				});
			}
		})();
	};

	const handleBodyEvent: SseBodyEventHandler = (event) => {
		if (event.type === "response.created") {
			const response = responseRecord(event);
			const responseId = typeof response?.id === "string" ? response.id : undefined;
			if (!responseId) return;
			activeResponseId = responseId;
			const tools = Array.isArray(response?.tools) ? response.tools : [];
			const imageTool = tools.find((tool) => itemRecord(tool)?.type === "image_generation");
			requests.set(responseId, {
				responseId,
				sourcePrompt: pendingRequest?.sourcePrompt,
				requestedParameters: parametersFrom(imageTool),
				eventTypes: new Set(["response.created"]),
				partialImages: 0,
			});
			pendingRequest = undefined;
			return;
		}

		if (typeof event.type !== "string") return;
		const response = responseRecord(event);
		if (response && typeof response.id === "string") activeResponseId = response.id;
		const request = activeResponseId ? requests.get(activeResponseId) : undefined;
		if (request) request.eventTypes.add(event.type);

		if (event.type === "response.output_item.added") {
			const item = itemRecord(event.item);
			if (!item || item.type !== "image_generation_call") return;
			const id = imageItemId(item) ?? `index:${String(event.output_index)}`;
			images.set(id, {
				id,
				responseId: activeResponseId,
				outputIndex: typeof event.output_index === "number" ? event.output_index : undefined,
				item: { ...item },
				eventTypes: new Set([event.type]),
				partialImages: 0,
			});
			return;
		}

		if (event.type.startsWith("response.image_generation_call.")) {
			const id = typeof event.item_id === "string" ? event.item_id : undefined;
			if (id) images.get(id)?.eventTypes.add(event.type);
			if (event.type.endsWith("partial_image")) {
				if (request) request.partialImages++;
				if (id) {
					const image = images.get(id);
					if (image) image.partialImages++;
				}
			}
			return;
		}

		if (event.type === "response.output_item.done") {
			const item = itemRecord(event.item);
			if (!item || item.type !== "image_generation_call") return;
			const id = imageItemId(item) ?? `index:${String(event.output_index)}`;
			const image = images.get(id);
			if (image) {
				image.item = { ...item };
				image.eventTypes.add(event.type);
			}
			saveImageItem(item, typeof event.output_index === "number" ? event.output_index : undefined);
			return;
		}

		if (event.type === "response.completed" || event.type === "response.incomplete") {
			const output = Array.isArray(response?.output) ? response.output : [];
			for (const value of output) {
				const item = itemRecord(value);
				if (item?.type === "image_generation_call") saveImageItem(item);
			}
		}
	};

	return {
		handleBodyEvent,
		handleProviderRequest(payload, requestContext) {
			const tools = Array.isArray(payload.tools) ? payload.tools : [];
			if (!tools.some((tool) => itemRecord(tool)?.type === "image_generation")) return;
			pendingRequest = {
				sourcePrompt: latestUserPrompt(requestContext),
				requestedParameters: {},
				eventTypes: new Set(),
				partialImages: 0,
			};
		},
	};
}
