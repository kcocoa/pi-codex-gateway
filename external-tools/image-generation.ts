import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isCodexGpt, isOpenAICodexGpt } from "../codex-provider.ts";

export const IMAGE_GENERATION_TOOL_NAME = "imagegen";
export const IMAGE_GENERATION_NAMESPACE = "image_gen";

const IMAGE_GENERATION_TOOL = {
	type: "image_generation",
} as const;

export const IMAGE_GENERATION_DESCRIPTION = `The image_gen.imagegen tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:

- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.
- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).

Guidelines:
- Omit both referenced_image_paths and num_last_images_to_include when generating a brand new image.
- For edits, use referenced_image_paths when every target image has a local file path.
- Use num_last_images_to_include only when at least one target image has no local file path.
- Set num_last_images_to_include to the smallest number of recent conversation images that includes every target image, up to 5.
- Never provide both referenced_image_paths and num_last_images_to_include.`;

const IMAGE_GENERATION_PARAMETERS = Type.Object({
	prompt: Type.String(),
	referenced_image_paths: Type.Optional(Type.Union([
		Type.Array(Type.String(), { maxItems: 5 }),
		Type.Null(),
	])),
	num_last_images_to_include: Type.Optional(Type.Union([
		Type.Integer({ minimum: 1, maximum: 5 }),
		Type.Null(),
	])),
});

// This is the exact Responses namespace schema emitted by Codex after its
// tool-input schema normalization. It is intentionally separate from the
// local TypeBox schema above: the reserved image_gen.imagegen tool validates
// the wire schema, including nullable optional fields and path metadata.
export const IMAGE_GENERATION_WIRE_PARAMETERS = {
	type: "object",
	properties: {
		num_last_images_to_include: { type: ["integer", "null"] },
		prompt: { type: "string" },
		referenced_image_paths: {
			type: ["array", "null"],
			items: {
				type: "string",
				description: "A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).\n\nIMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.",
			},
		},
	},
	required: ["prompt"],
	additionalProperties: false,
} as const;

type ImageGenerationParams = {
	prompt: string;
	referenced_image_paths?: string[];
	num_last_images_to_include?: number;
	// Internal aliases retained for the provider adapter and legacy callers.
	action?: "auto" | "generate" | "edit";
	size?: string;
	quality?: "low" | "medium" | "high" | "auto";
	background?: "transparent" | "opaque" | "auto";
	output_format?: "png" | "jpeg" | "jpg" | "webp";
	output_compression?: number;
	image_paths?: string[];
	use_conversation_images?: boolean;
	conversation_image_count?: number;
	output_path?: string;
	overwrite?: boolean;
};

type ImageOutput = {
	data: string;
	mimeType: string;
	path: string;
	revisedPrompt?: string;
};

type ResponsesPayload = {
	id?: string;
	output?: Array<Record<string, unknown>>;
	output_text?: string;
	error?: unknown;
};

type CodexImagesPayload = {
	data?: Array<{ b64_json?: unknown }>;
	error?: unknown;
};

const OPENAI_CODEX_IMAGE_MODEL = "gpt-image-2";
const OPENAI_CODEX_MAX_IMAGES = 5;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function normalizeImagePath(rawPath: string, cwd: string): string {
	const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return resolve(cwd, path);
}

function mimeTypeForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".bmp":
			return "image/bmp";
		case ".avif":
			return "image/avif";
		default:
			return "image/png";
	}
}

async function imagePathToInput(path: string, cwd: string): Promise<Record<string, string>> {
	const absolutePath = normalizeImagePath(path, cwd);
	const data = (await readFile(absolutePath)).toString("base64");
	return {
		type: "input_image",
		image_url: `data:${mimeTypeForPath(absolutePath)};base64,${data}`,
	};
}

function latestConversationImages(ctx: ExtensionContext): Array<Record<string, string>> {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user" || !Array.isArray(message.content)) continue;

		return message.content
			.filter(
				(item): item is { type: "image"; data: string; mimeType: string } =>
					!!item &&
					typeof item === "object" &&
					(item as { type?: unknown }).type === "image" &&
					typeof (item as { data?: unknown }).data === "string" &&
					typeof (item as { mimeType?: unknown }).mimeType === "string",
			)
			.map((item) => ({
				type: "input_image",
				image_url: `data:${item.mimeType};base64,${item.data}`,
			}));
	}
	return [];
}

function normalizeOutputFormat(format: ImageGenerationParams["output_format"]): "png" | "jpeg" | "webp" {
	if (!format) return "png";
	if (format === "jpg") return "jpeg";
	if (format === "png" || format === "jpeg" || format === "webp") return format;
	throw new Error(`Unsupported image output format: ${format}`);
}

function outputFormatFor(params: ImageGenerationParams): "png" | "jpeg" | "webp" {
	if (params.output_format) return normalizeOutputFormat(params.output_format);
	switch (extname(params.output_path ?? "").toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "jpeg";
		case ".webp":
			return "webp";
		default:
			return "png";
	}
}

function extensionForFormat(format: "png" | "jpeg" | "webp"): string {
	return format === "jpeg" ? ".jpg" : `.${format}`;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 60);
	return slug || "image";
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function uniqueOutputPath(path: string, overwrite: boolean): Promise<string> {
	if (overwrite || !(await exists(path))) return path;

	const extension = extname(path);
	const stem = path.slice(0, path.length - extension.length);
	for (let index = 2; index < 10_000; index++) {
		const candidate = `${stem}-${index}${extension}`;
		if (!(await exists(candidate))) return candidate;
	}
	throw new Error(`Unable to find an unused output path near ${path}`);
}

function outputDirectoryFor(ctx: ExtensionContext): string {
	// `getSessionFile()` is undefined for `pi --no-session` / ephemeral runs.
	// Keep those images outside the workspace and session tree as requested.
	if (ctx.sessionManager.getSessionFile() === undefined) return "/tmp/generated_images";
	return join(ctx.sessionManager.getSessionDir(), "generated_images");
}

function outputPathFor(
	ctx: ExtensionContext,
	params: ImageGenerationParams,
	format: "png" | "jpeg" | "webp",
): string {
	if (params.output_path) {
		const requestedPath = resolve(ctx.cwd, params.output_path.startsWith("@") ? params.output_path.slice(1) : params.output_path);
		return extname(requestedPath) ? requestedPath : `${requestedPath}${extensionForFormat(format)}`;
	}

	const directory = outputDirectoryFor(ctx);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(directory, `${timestamp}-${slugify(params.prompt)}${extensionForFormat(format)}`);
}

function decodeImageResult(
	result: string,
	requestedFormat: "png" | "jpeg" | "webp",
): { data: string; mimeType: string } {
	const dataUrl = result.match(/^data:([^;]+);base64,(.+)$/s);
	if (dataUrl) return { mimeType: dataUrl[1], data: dataUrl[2] };
	return {
		mimeType: requestedFormat === "jpeg" ? "image/jpeg" : `image/${requestedFormat}`,
		data: result,
	};
}

function buildImageTool(params: ImageGenerationParams, format: "png" | "jpeg" | "webp") {
	const tool: Record<string, unknown> = { ...IMAGE_GENERATION_TOOL };
	for (const key of ["action", "size", "quality", "background"] as const) {
		const value = params[key];
		if (value !== undefined) tool[key] = value;
	}
	tool.output_format = format;
	if (params.output_compression !== undefined) {
		if (params.output_compression < 0 || params.output_compression > 100) {
			throw new Error("output_compression must be between 0 and 100");
		}
		if (format !== "png") tool.output_compression = params.output_compression;
	}
	if (params.background === "transparent" && format === "jpeg") {
		throw new Error("Transparent images require PNG or WebP output");
	}
	return tool;
}

function extractOpenAICodexAccountId(token: string): string {
	try {
		const payload = JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
		) as Record<string, unknown>;
		const auth = payload[OPENAI_AUTH_CLAIM] as Record<string, unknown> | undefined;
		if (typeof auth?.chatgpt_account_id === "string") return auth.chatgpt_account_id;
	} catch {
		// Fall through to the common error below.
	}
	throw new Error("Failed to extract the ChatGPT account ID from OpenAI Codex authentication");
}

function openAICodexImageUrl(baseUrl: string, operation: "generations" | "edits"): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	const codexBase = normalized.endsWith("/codex/responses")
		? normalized.slice(0, -"/responses".length)
		: normalized.endsWith("/codex")
			? normalized
			: `${normalized}/codex`;
	return `${codexBase}/images/${operation}`;
}

async function callOpenAICodexImageGeneration(
	baseUrl: string,
	apiKey: string,
	authHeaders: Record<string, string>,
	params: ImageGenerationParams,
	inputImages: Array<Record<string, string>>,
	turnId: string,
	signal?: AbortSignal,
): Promise<{ outputs: ImageOutput[]; responseId?: string }> {
	if (outputFormatFor(params) !== "png" || params.output_compression !== undefined) {
		throw new Error("OpenAI Codex image generation currently supports PNG output only");
	}
	const editing = params.action === "edit" || inputImages.length > 0;
	if (params.action === "edit" && inputImages.length === 0) {
		throw new Error("OpenAI Codex image editing requires at least one input image");
	}
	const requestBody: Record<string, unknown> = {
		prompt: params.prompt,
		model: OPENAI_CODEX_IMAGE_MODEL,
	};
	for (const key of ["background", "quality", "size"] as const) {
		const value = params[key];
		if (value !== undefined) requestBody[key] = value;
	}
	if (editing) {
		requestBody.images = inputImages.map((image) => ({ image_url: image.image_url }));
	}

	const headers: Record<string, string> = {
		...authHeaders,
		"content-type": "application/json",
		"chatgpt-account-id": extractOpenAICodexAccountId(apiKey),
		"x-codex-image-turn-id": turnId,
		originator: "pi",
	};
	if (!Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const response = await fetch(openAICodexImageUrl(baseUrl, editing ? "edits" : "generations"), {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
		signal,
	});
	const rawBody = await response.text();
	let body: CodexImagesPayload;
	try {
		body = JSON.parse(rawBody) as CodexImagesPayload;
	} catch {
		throw new Error(`Image generation returned non-JSON HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
	}
	if (!response.ok) {
		const errorText = typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? body).slice(0, 1000);
		throw new Error(`Image generation failed (HTTP ${response.status}): ${errorText}`);
	}

	const outputs = (body.data ?? [])
		.map((item) => typeof item.b64_json === "string" && item.b64_json.length > 0
			? { data: item.b64_json, mimeType: "image/png", path: "" }
			: undefined)
		.filter((item): item is ImageOutput => item !== undefined);
	if (outputs.length === 0) {
		throw new Error("The OpenAI Codex Images API did not return image data");
	}
	return {
		outputs,
		responseId: response.headers.get("x-codex-imagegen-request-id") ?? undefined,
	};
}

async function callImageGeneration(
	ctx: ExtensionContext,
	params: ImageGenerationParams,
	turnId: string,
	signal?: AbortSignal,
): Promise<{ outputs: ImageOutput[]; responseId?: string }> {
	const model = ctx.model;
	if (!model || !isCodexGpt(ctx)) {
		throw new Error("image_gen is only available with a Codex GPT model");
	}

	const requestAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!requestAuth.ok) throw new Error(requestAuth.error);
	const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
	const apiKey = requestAuth.apiKey;
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(requestAuth.headers ?? {})) {
		if (typeof value === "string") headers[key] = value;
	}
	if (!apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		throw new Error(`No API key configured for provider ${model.provider}`);
	}

	const baseUrl = (
		requestAuth.baseUrl ?? providerAuth?.auth.baseUrl ?? model.baseUrl
	).replace(/\/+$/, "");
	const format = outputFormatFor(params);
	const explicitImages = params.image_paths ?? [];
	const imageLimit = isOpenAICodexGpt(ctx) ? OPENAI_CODEX_MAX_IMAGES : 16;
	if (explicitImages.length > imageLimit) {
		throw new Error(`${model.provider} image generation supports at most ${imageLimit} input images`);
	}
	const conversationImageCount = Math.min(
		params.conversation_image_count ?? imageLimit,
		imageLimit,
	);
	const inputImages = explicitImages.length > 0
		? await Promise.all(explicitImages.map((path) => imagePathToInput(path, ctx.cwd)))
		: params.use_conversation_images === false
			? []
			: latestConversationImages(ctx).slice(-conversationImageCount);

	if (isOpenAICodexGpt(ctx)) {
		if (!apiKey) throw new Error("OpenAI Codex image generation requires OAuth authentication");
		return callOpenAICodexImageGeneration(baseUrl, apiKey, headers, params, inputImages, turnId, signal);
	}

	const input = inputImages.length > 0
		? [{
				role: "user",
				content: [
					{ type: "input_text", text: params.prompt },
					...inputImages,
				],
			}]
		: params.prompt;

	const requestBody = {
		model: model.id,
		input,
		tools: [buildImageTool(params, format)],
		tool_choice: { type: "image_generation" },
		stream: false,
		store: false,
	};

	headers["content-type"] = "application/json";
	if (apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const response = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
		signal,
	});
	const rawBody = await response.text();
	let body: ResponsesPayload;
	try {
		body = JSON.parse(rawBody) as ResponsesPayload;
	} catch {
		throw new Error(`Image generation returned non-JSON HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
	}
	if (!response.ok) {
		const errorText = typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? body).slice(0, 1000);
		throw new Error(`Image generation failed (HTTP ${response.status}): ${errorText}`);
	}

	const generated: ImageOutput[] = [];
	for (const item of body.output ?? []) {
		if (item.type !== "image_generation_call" || typeof item.result !== "string" || item.result.length === 0) {
			continue;
		}
		const decoded = decodeImageResult(item.result, format);
		generated.push({
			data: decoded.data,
			mimeType: decoded.mimeType,
			path: "",
			revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
		});
	}

	if (generated.length === 0) {
		const text = body.output_text ? ` Output text: ${body.output_text}` : "";
		throw new Error(`The Responses API did not return an image_generation_call.${text}`);
	}

	return { outputs: generated, responseId: body.id };
}

export function registerImageGeneration(pi: ExtensionAPI): void {
	pi.registerTool({
		name: IMAGE_GENERATION_TOOL_NAME,
		label: "Image Generation",
		description: IMAGE_GENERATION_DESCRIPTION,
		promptSnippet: "Generate or edit raster images with image_gen.imagegen",
		promptGuidelines: [
			"Use image_gen.imagegen for AI-created or AI-edited raster images; do not substitute SVG, HTML, or CLI scripts when a bitmap is requested.",
			"Use referenced_image_paths for local edit/reference images, or num_last_images_to_include for recent conversation images.",
			"image_gen.imagegen saves outputs under the current Pi session's generated_images directory by default.",
		],
		parameters: IMAGE_GENERATION_PARAMETERS,
		async execute(toolCallId, rawParams, signal, _onUpdate, ctx) {
			const input = rawParams as ImageGenerationParams;
			const params: ImageGenerationParams = {
				...input,
				image_paths: input.referenced_image_paths,
				use_conversation_images: input.num_last_images_to_include !== undefined,
				conversation_image_count: input.num_last_images_to_include,
			};
			const result = await callImageGeneration(ctx, params, toolCallId, signal);
			const format = outputFormatFor(params);
			const firstPath = outputPathFor(ctx, params, format);
			const paths: string[] = [];
			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

			for (const [index, output] of result.outputs.entries()) {
				const requestedPath = index === 0
					? firstPath
					: `${firstPath.slice(0, firstPath.length - extname(firstPath).length)}-${index + 1}${extname(firstPath)}`;
				const outputPath = await uniqueOutputPath(requestedPath, params.overwrite === true);
				await mkdir(dirname(outputPath), { recursive: true });
				await writeFile(outputPath, Buffer.from(output.data, "base64"));
				output.path = outputPath;
				paths.push(outputPath);
				content.push({ type: "image", data: output.data, mimeType: output.mimeType });
			}

			content.unshift({ type: "text", text: `Generated image${paths.length > 1 ? "s" : ""}:\n${paths.join("\n")}` });
			return {
				content,
				details: {
					paths,
					responseId: result.responseId,
					revisedPrompts: result.outputs.map((output) => output.revisedPrompt).filter(Boolean),
				},
			};
		},
	});
}

export function syncImageGenerationTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools().filter((name) => name !== IMAGE_GENERATION_TOOL_NAME);
	if (isCodexGpt(ctx)) active.push(IMAGE_GENERATION_TOOL_NAME);
	pi.setActiveTools([...new Set(active)]);
}
