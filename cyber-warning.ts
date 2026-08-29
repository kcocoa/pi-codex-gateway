import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CodexGatewayStreamEvent } from "./codex-sse.ts";
import {
	getServerModelFromResponseHeaders,
	getServerModelFromStreamEvent,
	hasTrustedAccessForCyberRecommendation,
} from "./codex-signals.ts";

export type CyberWarningAction = "warn" | "stop" | "stop-after-repeat";

const DEFAULT_ACTION: CyberWarningAction = "warn";
const REPEATED_WARNING_LIMIT = 2;
const CONFIG_PATH = join(getAgentDir(), "codex-gateway.json");

const ACTION_LABELS: Record<CyberWarningAction, string> = {
	warn: "Show warnings only",
	stop: "Stop the current turn on the first warning",
	"stop-after-repeat": `Stop on the ${REPEATED_WARNING_LIMIT}nd warned turn in this session`,
};

interface CodexGatewayConfig {
	cyberWarningAction?: CyberWarningAction;
	[key: string]: unknown;
}

export interface CyberWarningSupport {
	handleStreamEvent(event: CodexGatewayStreamEvent): void;
}

function isCyberWarningAction(value: unknown): value is CyberWarningAction {
	return value === "warn" || value === "stop" || value === "stop-after-repeat";
}

async function readConfig(): Promise<CodexGatewayConfig> {
	try {
		const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as CodexGatewayConfig
			: {};
	} catch {
		return {};
	}
}

async function writeAction(action: CyberWarningAction): Promise<void> {
	const config = await readConfig();
	config.cyberWarningAction = action;
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function isCodexGatewayGpt(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "codex-gateway" && /^gpt-/i.test(ctx.model.id);
}

export async function registerCyberWarningSupport(pi: ExtensionAPI): Promise<CyberWarningSupport> {
	const config = await readConfig();
	let action = isCyberWarningAction(config.cyberWarningAction) ? config.cyberWarningAction : DEFAULT_ACTION;
	let activeContext: ExtensionContext | undefined;
	let requestedModel: string | undefined;
	let warnedTurns = 0;
	let countedCurrentTurn = false;
	let abortingCurrentTurn = false;
	const warningKeys = new Set<string>();

	const resetSessionState = (): void => {
		activeContext = undefined;
		requestedModel = undefined;
		warnedTurns = 0;
		countedCurrentTurn = false;
		abortingCurrentTurn = false;
		warningKeys.clear();
	};

	const notifyWarning = (ctx: ExtensionContext, key: string, message: string): void => {
		if (warningKeys.has(key) || abortingCurrentTurn) return;
		warningKeys.add(key);

		if (!countedCurrentTurn) {
			warnedTurns++;
			countedCurrentTurn = true;
		}

		const shouldStop = action === "stop" ||
			(action === "stop-after-repeat" && warnedTurns >= REPEATED_WARNING_LIMIT);
		const suffix = shouldStop
			? " Stopping the current turn; switch model or authentication before retrying."
			: action === "stop-after-repeat"
				? ` Warned turn ${warnedTurns}/${REPEATED_WARNING_LIMIT}; the next warned turn will be stopped.`
				: "";
		ctx.ui.notify(`${message}${suffix}`, "warning");

		if (shouldStop && !ctx.isIdle()) {
			abortingCurrentTurn = true;
			ctx.abort();
		}
	};

	const handleServerModel = (ctx: ExtensionContext, serverModel: string): void => {
		const fromModel = requestedModel ?? ctx.model?.id;
		if (!fromModel || fromModel.toLowerCase() === serverModel.toLowerCase()) return;
		notifyWarning(
			ctx,
			`reroute:${fromModel.toLowerCase()}:${serverModel.toLowerCase()}`,
			`Codex Gateway cyber warning: requested ${fromModel}, but the server routed this turn to ${serverModel}.`,
		);
	};

	pi.registerCommand("codex-gateway:settings", {
		description: "Configure Codex Gateway cyber-warning handling",
		handler: async (args, ctx) => {
			const requestedAction = args.trim();
			let nextAction: CyberWarningAction | undefined;
			if (requestedAction) {
				if (!isCyberWarningAction(requestedAction)) {
					ctx.ui.notify("Expected one of: warn, stop, stop-after-repeat", "error");
					return;
				}
				nextAction = requestedAction;
			} else if (ctx.hasUI) {
				const labels = (Object.keys(ACTION_LABELS) as CyberWarningAction[]).map(
					(value) => `${value === action ? "●" : "○"} ${ACTION_LABELS[value]}`,
				);
				const selected = await ctx.ui.select("Codex Gateway cyber warnings", labels);
				const index = selected ? labels.indexOf(selected) : -1;
				if (index < 0) return;
				nextAction = (Object.keys(ACTION_LABELS) as CyberWarningAction[])[index];
			} else {
				ctx.ui.notify(`Codex Gateway cyber-warning action: ${action}`, "info");
				return;
			}

			action = nextAction;
			warnedTurns = 0;
			await writeAction(action);
			ctx.ui.notify(`Codex Gateway cyber-warning action: ${action}`, "info");
		},
	});

	pi.on("session_start", () => resetSessionState());
	pi.on("session_shutdown", () => resetSessionState());
	pi.on("model_select", () => resetSessionState());
	pi.on("turn_start", (_event, ctx) => {
		activeContext = isCodexGatewayGpt(ctx) ? ctx : undefined;
		requestedModel = activeContext?.model?.id;
		countedCurrentTurn = false;
		abortingCurrentTurn = false;
		warningKeys.clear();
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!isCodexGatewayGpt(ctx)) return;
		const serverModel = getServerModelFromResponseHeaders(event.headers);
		if (serverModel) handleServerModel(ctx, serverModel);
	});

	return {
		handleStreamEvent(event) {
			const ctx = activeContext;
			if (!ctx || !isCodexGatewayGpt(ctx)) return;

			const serverModel = getServerModelFromStreamEvent(event);
			if (serverModel) handleServerModel(ctx, serverModel);
			if (hasTrustedAccessForCyberRecommendation(event)) {
				notifyWarning(
					ctx,
					"trusted-access-for-cyber",
					"Codex Gateway cyber warning: repeated cybersecurity-risk flags enabled additional safety checks. Trusted Access for Cyber or different authentication may be required.",
				);
			}
		},
	};
}
