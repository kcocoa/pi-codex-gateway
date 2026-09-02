/**
 * Diagnostic-only Pi hook probe.
 *
 * It registers lifecycle/provider hooks without registering a provider, wrapping
 * fetch/WebSocket, or mutating requests. Logs contain structure and lengths only.
 * Example: PI_HOOK_PROBE_LOG=/tmp/hooks.ndjson pi -ne -e ./experiments/official-hooks-probe.ts
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_LOG = "/tmp/pi-official-hooks.ndjson";
const logPath = resolve(process.env.PI_HOOK_PROBE_LOG || DEFAULT_LOG);
const SECRET_HEADER =
	/^(authorization|cookie|set-cookie|x-api-key|chatgpt-account-id|x-codex-turn-state)$/i;
const SAFE_HEADER_VALUE =
	/^(content-type|retry-after|openai-model|x-openai-model|x-codex-(active-limit|credits-|plan-type|primary-|secondary-))/i;
const PROBED_EVENTS = [
	"resources_discover",
	"session_start",
	"session_info_changed",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"session_shutdown",
	"session_before_tree",
	"session_tree",
	"context",
	"before_provider_request",
	"before_provider_headers",
	"after_provider_response",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"agent_settled",
	"ui_prompt_start",
	"ui_prompt_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"model_select",
	"thinking_level_select",
	"tool_call",
	"tool_result",
	"user_bash",
	"input",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function lengthOf(value: unknown): number | undefined {
	return typeof value === "string" ? value.length : undefined;
}

function keysOf(value: unknown): string[] {
	const record = asRecord(value);
	return record ? Object.keys(record).sort() : [];
}

function modelSummary(model: unknown): Record<string, unknown> | undefined {
	const m = asRecord(model);
	if (!m) return undefined;
	return { provider: m.provider, id: m.id, api: m.api };
}

function safeArgv(argv: string[]): string[] {
	return argv.map((arg) => {
		if (arg.startsWith("--")) return arg.split("=", 1)[0];
		return "<non-flag>";
	});
}

function usageSummary(usage: unknown): Record<string, unknown> | undefined {
	const u = asRecord(usage);
	if (!u) return undefined;
	const cost = asRecord(u.cost);
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		reasoning: u.reasoning,
		totalTokens: u.totalTokens,
		cost: cost
			? {
					input: cost.input,
					output: cost.output,
					cacheRead: cost.cacheRead,
					cacheWrite: cost.cacheWrite,
					total: cost.total,
				}
			: undefined,
	};
}

function contentBlockSummary(block: unknown): Record<string, unknown> {
	const b = asRecord(block);
	if (!b) return { type: typeof block };
	const type = typeof b.type === "string" ? b.type : "unknown";
	const result: Record<string, unknown> = { type };

	for (const field of [
		"text",
		"thinking",
		"delta",
		"arguments",
		"input",
		"refusal",
	]) {
		const length = lengthOf(b[field]);
		if (length !== undefined) result[`${field}Length`] = length;
	}
	if (typeof b.name === "string") result.name = b.name;
	if (typeof b.call_id === "string" || typeof b.callId === "string")
		result.hasCallId = true;
	if (typeof b.id === "string") result.hasId = true;
	if (
		typeof b.textSignature === "string" ||
		typeof b.thinkingSignature === "string"
	)
		result.hasSignature = true;
	if (Array.isArray(b.content)) result.contentBlockCount = b.content.length;
	if (Array.isArray(b.summary)) result.summaryBlockCount = b.summary.length;
	return result;
}

function messageSummary(message: unknown): Record<string, unknown> | undefined {
	const m = asRecord(message);
	if (!m) return undefined;
	return {
		role: m.role,
		api: m.api,
		provider: m.provider,
		model: m.model,
		content: Array.isArray(m.content) ? m.content.map(contentBlockSummary) : [],
		usage: usageSummary(m.usage),
		stopReason: m.stopReason,
		rawStopReason: m.rawStopReason,
		responseId: typeof m.responseId === "string" ? "<present>" : undefined,
		errorMessageLength: lengthOf(m.errorMessage),
		timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
	};
}

function assistantEventSummary(
	event: unknown,
): Record<string, unknown> | undefined {
	const e = asRecord(event);
	if (!e) return undefined;
	const result: Record<string, unknown> = {
		type: e.type,
		contentIndex: e.contentIndex,
		reason: e.reason,
		partial: messageSummary(e.partial),
	};
	for (const field of ["delta", "content", "thinking"]) {
		const length = lengthOf(e[field]);
		if (length !== undefined) result[`${field}Length`] = length;
	}
	if (e.toolCall !== undefined)
		result.toolCall = contentBlockSummary(e.toolCall);
	if (e.message !== undefined) result.message = messageSummary(e.message);
	return result;
}

function messageEventSummary(event: unknown): Record<string, unknown> {
	const e = asRecord(event);
	return {
		type: e?.type,
		message: messageSummary(e?.message),
		assistantMessageEvent: assistantEventSummary(e?.assistantMessageEvent),
	};
}

function contextMessagesSummary(messages: unknown): Record<string, unknown> {
	const list = Array.isArray(messages) ? messages : [];
	return {
		messageCount: list.length,
		messages: list.map((message) => messageSummary(message)),
	};
}

function inputSummary(input: unknown): Record<string, unknown> {
	const list = Array.isArray(input) ? input : [];
	return {
		itemCount: list.length,
		items: list.map((item) => {
			const i = asRecord(item);
			return {
				role: i?.role,
				type: i?.type,
				contentBlockTypes: Array.isArray(i?.content)
					? i.content.map(
							(block: unknown) => asRecord(block)?.type ?? typeof block,
						)
					: undefined,
				contentBlockCount: Array.isArray(i?.content)
					? i.content.length
					: undefined,
				textLength: lengthOf(i?.text),
			};
		}),
	};
}

function toolsSummary(tools: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(tools)) return undefined;
	return {
		count: tools.length,
		tools: tools.map((tool) => {
			const t = asRecord(tool);
			return { type: t?.type, name: t?.name, keys: keysOf(tool) };
		}),
	};
}

function payloadSummary(payload: unknown): Record<string, unknown> {
	const p = asRecord(payload) ?? {};
	const reasoning = asRecord(p.reasoning);
	const text = asRecord(p.text);
	const toolChoice = asRecord(p.tool_choice);
	return {
		keys: Object.keys(p).sort(),
		model: p.model,
		stream: p.stream,
		store: p.store,
		maxOutputTokens: p.max_output_tokens,
		input: inputSummary(p.input),
		instructionsLength: lengthOf(p.instructions),
		include: Array.isArray(p.include) ? p.include : undefined,
		text: text
			? { keys: Object.keys(text).sort(), verbosity: text.verbosity }
			: undefined,
		reasoning: reasoning
			? {
					keys: Object.keys(reasoning).sort(),
					effort: reasoning.effort,
					summary: reasoning.summary,
				}
			: undefined,
		toolChoice: toolChoice
			? { keys: Object.keys(toolChoice).sort(), type: toolChoice.type }
			: p.tool_choice,
		tools: toolsSummary(p.tools),
		previousResponseId: p.previous_response_id !== undefined,
		promptCacheKey: p.prompt_cache_key !== undefined,
		parallelToolCalls: p.parallel_tool_calls,
	};
}

function headersSummary(headers: unknown): Record<string, unknown> {
	const h = asRecord(headers) ?? {};
	const names = Object.keys(h).sort();
	const safeValues: Record<string, unknown> = {};
	for (const name of names) {
		if (SECRET_HEADER.test(name)) continue;
		if (SAFE_HEADER_VALUE.test(name)) safeValues[name] = h[name];
	}
	return { names, safeValues };
}

function contextSummary(ctx: ExtensionContext): Record<string, unknown> {
	return {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		cwd: ctx.cwd,
		model: modelSummary(ctx.model),
		thinkingLevel: ctx.thinkingLevel,
		isIdle: ctx.isIdle(),
	};
}

function record(type: string, data: unknown): void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(
			logPath,
			`${JSON.stringify({ timestamp: new Date().toISOString(), type, data })}\n`,
			"utf8",
		);
	} catch {
		// A diagnostic probe must never affect Pi's operation.
	}
}

export default function officialHooksProbe(pi: ExtensionAPI): void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, "", { mode: 0o600 });
	} catch {}

	record("extension_loaded", {
		pid: process.pid,
		logPath,
		argv: safeArgv(process.argv),
		registeredEvents: PROBED_EVENTS,
		projectTrustHook:
			"intentionally not registered because it requires a trust decision",
	});

	pi.on("session_start", (event, ctx) => {
		record("session_start", {
			event: { type: event.type, reason: event.reason },
			context: contextSummary(ctx),
			commands: pi
				.getCommands()
				.map((command) => ({ name: command.name, source: command.source })),
			activeTools: pi.getActiveTools().map((tool) => tool.name),
			allTools: pi
				.getAllTools()
				.map((tool) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
		});
	});
	pi.on("resources_discover", (event) => {
		record("resources_discover", {
			event: { type: event.type, cwd: event.cwd, reason: event.reason },
		});
	});
	pi.on("session_info_changed", (event, ctx) => {
		record("session_info_changed", {
			event: {
				type: event.type,
				namePresent: event.name !== undefined,
				nameLength: lengthOf(event.name),
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("session_before_switch", (event, ctx) => {
		record("session_before_switch", {
			event: {
				type: event.type,
				reason: event.reason,
				targetSessionPresent: event.targetSessionFile !== undefined,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("session_before_fork", (event, ctx) => {
		record("session_before_fork", {
			event: {
				type: event.type,
				entryIdPresent: Boolean(event.entryId),
				position: event.position,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("session_before_compact", (event, ctx) => {
		record("session_before_compact", {
			event: {
				type: event.type,
				reason: event.reason,
				willRetry: event.willRetry,
				preparationKeys: keysOf(event.preparation),
				branchEntryCount: event.branchEntries.length,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("session_compact", (event, ctx) => {
		record("session_compact", {
			event: {
				type: event.type,
				reason: event.reason,
				willRetry: event.willRetry,
				fromExtension: event.fromExtension,
				compactionEntryKeys: keysOf(event.compactionEntry),
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("session_compact_failed", (event, ctx) => {
		record("session_compact_failed", {
			event: {
				type: event.type,
				reason: event.reason,
				aborted: event.aborted,
				willRetry: event.willRetry,
				fromExtension: event.fromExtension,
				errorMessageLength: lengthOf(event.errorMessage),
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("session_before_tree", (event, ctx) => {
		record("session_before_tree", {
			event: { type: event.type, preparationKeys: keysOf(event.preparation) },
			context: contextSummary(ctx),
		});
	});
	pi.on("session_tree", (event, ctx) => {
		record("session_tree", {
			event: {
				type: event.type,
				newLeafPresent: event.newLeafId !== null,
				oldLeafPresent: event.oldLeafId !== null,
				summaryPresent: event.summaryEntry !== undefined,
				fromExtension: event.fromExtension,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("session_shutdown", (event, ctx) => {
		record("session_shutdown", {
			event: {
				type: event.type,
				reason: event.reason,
				targetSessionPresent: event.targetSessionFile !== undefined,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("model_select", (event, ctx) => {
		record("model_select", {
			event: {
				type: event.type,
				model: modelSummary(event.model),
				previousModelPresent: event.previousModel !== undefined,
				source: event.source,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("thinking_level_select", (event, ctx) => {
		record("thinking_level_select", {
			event: { type: event.type, level: event.level },
			context: contextSummary(ctx),
		});
	});
	pi.on("before_agent_start", (event, ctx) => {
		record("before_agent_start", {
			event: {
				type: event.type,
				promptLength: event.prompt.length,
				systemPromptLength: event.systemPrompt.length,
				imageCount: event.images?.length ?? 0,
				systemPromptOptionKeys: keysOf(event.systemPromptOptions),
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("ui_prompt_start", (event, ctx) => {
		record("ui_prompt_start", {
			event: {
				type: event.type,
				reason: event.reason,
				kind: event.kind,
				titlePresent: event.title !== undefined,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("ui_prompt_end", (event, ctx) => {
		record("ui_prompt_end", {
			event: {
				type: event.type,
				reason: event.reason,
				kind: event.kind,
				titlePresent: event.title !== undefined,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("agent_start", (event, ctx) => {
		record("agent_start", {
			event: { type: event.type },
			context: contextSummary(ctx),
		});
	});
	pi.on("agent_end", (event, ctx) => {
		record("agent_end", {
			event: { type: event.type, messages: event.messages.map(messageSummary) },
			context: contextSummary(ctx),
		});
	});
	pi.on("agent_settled", (event, ctx) => {
		record("agent_settled", {
			event: { type: event.type },
			context: contextSummary(ctx),
		});
	});
	pi.on("turn_start", (event, ctx) => {
		record("turn_start", {
			event: { type: event.type, turnIndex: event.turnIndex },
			context: contextSummary(ctx),
		});
	});
	pi.on("turn_end", (event, ctx) => {
		record("turn_end", {
			event: {
				type: event.type,
				turnIndex: event.turnIndex,
				message: messageSummary(event.message),
				toolResultCount: event.toolResults.length,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("message_start", (event, ctx) => {
		record("message_start", {
			event: messageEventSummary(event),
			context: contextSummary(ctx),
		});
	});
	pi.on("message_update", (event, ctx) => {
		record("message_update", {
			event: messageEventSummary(event),
			context: contextSummary(ctx),
		});
	});
	pi.on("message_end", (event, ctx) => {
		record("message_end", {
			event: messageEventSummary(event),
			context: contextSummary(ctx),
		});
	});
	pi.on("context", (event, ctx) => {
		record("context", {
			event: contextMessagesSummary(event.messages),
			context: contextSummary(ctx),
		});
	});
	pi.on("before_provider_headers", (event, ctx) => {
		record("before_provider_headers", {
			event: {
				type: event.type,
				headerNames: Object.keys(event.headers).sort(),
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("before_provider_request", (event, ctx) => {
		record("before_provider_request", {
			event: { type: event.type, payload: payloadSummary(event.payload) },
			context: contextSummary(ctx),
		});
	});
	pi.on("after_provider_response", (event, ctx) => {
		record("after_provider_response", {
			event: {
				type: event.type,
				status: event.status,
				headers: headersSummary(event.headers),
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("tool_execution_start", (event, ctx) => {
		record("tool_execution_start", {
			event: {
				type: event.type,
				toolCallIdPresent: Boolean(event.toolCallId),
				toolName: event.toolName,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("tool_execution_update", (event, ctx) => {
		record("tool_execution_update", {
			event: {
				type: event.type,
				toolCallIdPresent: Boolean(event.toolCallId),
				toolName: event.toolName,
				updateKeys: keysOf(event),
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("tool_execution_end", (event, ctx) => {
		record("tool_execution_end", {
			event: {
				type: event.type,
				toolCallIdPresent: Boolean(event.toolCallId),
				toolName: event.toolName,
				isError: event.isError,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("tool_call", (event, ctx) => {
		record("tool_call", {
			event: {
				type: event.type,
				toolCall: contentBlockSummary(event.toolCall),
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("tool_result", (event, ctx) => {
		record("tool_result", {
			event: {
				type: event.type,
				toolCallIdPresent: Boolean(event.toolCallId),
				isError: event.isError,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("user_bash", (event, ctx) => {
		record("user_bash", {
			event: {
				type: event.type,
				commandLength: event.command.length,
				excludeFromContext: event.excludeFromContext,
				cwd: event.cwd,
			},
			context: contextSummary(ctx),
		});
	});
	pi.on("input", (event, ctx) => {
		record("input", {
			event: {
				type: event.type,
				textLength: event.text.length,
				imageCount: event.images?.length ?? 0,
				source: event.source,
				streamingBehavior: event.streamingBehavior,
			},
			context: contextSummary(ctx),
		});
	});
}
