import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const IMAGE_GENERATION_TOOL_NAME = "image_gen";

const IMAGE_GENERATION_TOOL = {
	type: "image_generation",
} as const;

type ImageGenerationParams = {
	prompt: string;
	action?: "auto" | "generate" | "edit";
	size?: string;
	quality?: "low" | "medium" | "high" | "auto";
	background?: "transparent" | "opaque" | "auto";
	output_format?: "png" | "jpeg" | "jpg" | "webp";
	output_compression?: number;
	image_paths?: string[];
	use_conversation_images?: boolean;
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

function isCodexGatewayGpt(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "codex-gateway" && /^gpt-/i.test(ctx.model.id);
}

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
		tool.output_compression = params.output_compression;
	}
	if (params.background === "transparent" && format === "jpeg") {
		throw new Error("Transparent images require PNG or WebP output");
	}
	return tool;
}

async function callImageGeneration(
	ctx: ExtensionContext,
	params: ImageGenerationParams,
	signal?: AbortSignal,
): Promise<{ outputs: ImageOutput[]; responseId?: string }> {
	if (!isCodexGatewayGpt(ctx)) {
		throw new Error("image_gen is only available with the codex-gateway provider");
	}

	const model = ctx.model;
	const requestAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!requestAuth.ok) throw new Error(requestAuth.error);
	const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
	const apiKey = requestAuth.apiKey;
	const authHeaders = requestAuth.headers ?? {};
	if (!apiKey && !Object.keys(authHeaders).some((key) => key.toLowerCase() === "authorization")) {
		throw new Error(`No API key configured for provider ${model.provider}`);
	}

	const format = outputFormatFor(params);
	const explicitImages = params.image_paths ?? [];
	const inputImages = explicitImages.length > 0
		? await Promise.all(explicitImages.slice(0, 16).map((path) => imagePathToInput(path, ctx.cwd)))
		: params.use_conversation_images === false
			? []
			: latestConversationImages(ctx).slice(0, 16);

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

	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	for (const [key, value] of Object.entries(authHeaders)) {
		if (value !== null) headers[key] = value;
	}
	if (apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const baseUrl = (providerAuth?.auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
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

	const calls = (body.output ?? []).filter((item) => item.type === "image_generation_call");
	const generated = calls
		.map((item) => {
			const result = item.result;
			if (typeof result !== "string" || result.length === 0) return undefined;
			const decoded = decodeImageResult(result, format);
			return {
				data: decoded.data,
				mimeType: decoded.mimeType,
				path: "",
				revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
			};
		})
		.filter((item): item is ImageOutput => item !== undefined);

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
		description:
			"Generate or edit raster images through the Codex Gateway provider's native Responses image_generation tool. Saves outputs under the current Pi session directory by default and returns the generated image to the model.",
		promptSnippet: "Generate or edit raster images with the provider-native image generation tool",
		promptGuidelines: [
			"Use image_gen for AI-created or AI-edited raster images; do not substitute SVG, HTML, or CLI scripts when a bitmap is requested.",
			"Use image_paths for local edit/reference images when the user identifies files; use output_path only when the user requests a specific destination.",
			"image_gen saves to the current Pi session's generated_images directory by default, or /tmp/generated_images for --no-session runs, and does not overwrite existing files unless overwrite is true.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "A complete image generation or editing prompt" }),
			action: Type.Optional(Type.String({ description: "auto, generate, or edit" })),
			size: Type.Optional(Type.String({ description: "Image size such as 1024x1024, 1536x1024, or auto" })),
			quality: Type.Optional(Type.String({ description: "low, medium, high, or auto" })),
			background: Type.Optional(Type.String({ description: "transparent, opaque, or auto" })),
			output_format: Type.Optional(Type.String({ description: "png, jpeg, jpg, or webp" })),
			output_compression: Type.Optional(Type.Number({ description: "JPEG/WebP compression from 0 to 100" })),
			image_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
			use_conversation_images: Type.Optional(Type.Boolean({ description: "Use images attached to the latest user message when image_paths is omitted" })),
			output_path: Type.Optional(Type.String({ description: "Optional destination path, relative to the project cwd" })),
			overwrite: Type.Optional(Type.Boolean({ description: "Allow replacing an existing output file" })),
		}),
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = rawParams as ImageGenerationParams;
			const result = await callImageGeneration(ctx, params, signal);
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
	if (isCodexGatewayGpt(ctx)) active.push(IMAGE_GENERATION_TOOL_NAME);
	pi.setActiveTools([...new Set(active)]);
}

export { isCodexGatewayGpt };
