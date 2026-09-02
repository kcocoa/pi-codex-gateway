import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readCodexConfig, updateCodexConfig } from "./codex-config.ts";
import { codexProviderLabel, isCodexGpt } from "./codex-provider.ts";
import {
	getServerModelFromBodyEvent,
	getServerModelFromResponseHeaders,
	hasTrustedAccessForCyberRecommendation,
} from "./codex-signals.ts";
import type { SseBodyEvent } from "./codex-sse.ts";
import {
	type CyberWarningAction,
	REPEATED_WARNING_LIMIT,
	serverModelWarningKey,
	shouldStopCyberWarning,
	TRUSTED_ACCESS_WARNING_KEY,
} from "./cyber-warning-policy.ts";

const DEFAULT_ACTION: CyberWarningAction = "warn";

const ACTION_LABELS: Record<CyberWarningAction, string> = {
	warn: "Show warnings only",
	stop: "Stop the current turn on the first warning",
	"stop-after-repeat": `Stop on the ${REPEATED_WARNING_LIMIT}nd warned turn in this session`,
};
const ACTIONS = Object.keys(ACTION_LABELS) as CyberWarningAction[];

export interface CyberWarningSupport {
	handleResponseHeaders(
		headers: Record<string, string>,
		ctx: ExtensionContext,
	): void;
	handleBodyEvent(event: SseBodyEvent, ctx?: ExtensionContext): void;
}

function isCyberWarningAction(value: unknown): value is CyberWarningAction {
	return value === "warn" || value === "stop" || value === "stop-after-repeat";
}

export async function registerCyberWarningSupport(
	pi: ExtensionAPI,
): Promise<CyberWarningSupport> {
	const config = await readCodexConfig();
	let action = isCyberWarningAction(config.cyberWarningAction)
		? config.cyberWarningAction
		: DEFAULT_ACTION;
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

	const notifyWarning = (
		ctx: ExtensionContext,
		key: string,
		message: string,
	): void => {
		if (warningKeys.has(key) || abortingCurrentTurn) return;
		warningKeys.add(key);

		if (!countedCurrentTurn) {
			warnedTurns++;
			countedCurrentTurn = true;
		}

		const shouldStop = shouldStopCyberWarning(action, warnedTurns);
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

	const handleServerModel = (
		ctx: ExtensionContext,
		serverModel: string,
	): void => {
		const fromModel = requestedModel ?? ctx.model?.id;
		if (!fromModel || fromModel.toLowerCase() === serverModel.toLowerCase())
			return;
		notifyWarning(
			ctx,
			serverModelWarningKey(fromModel, serverModel),
			`${codexProviderLabel(ctx.model?.provider)} cyber warning: requested ${fromModel}, but the server routed this turn to ${serverModel}.`,
		);
	};

	pi.registerCommand("codex:cyber", {
		description: "Configure Codex cyber-warning handling",
		handler: async (args, ctx) => {
			const requestedAction = args.trim();
			let nextAction: CyberWarningAction | undefined;
			if (requestedAction) {
				if (!isCyberWarningAction(requestedAction)) {
					ctx.ui.notify(
						"Expected one of: warn, stop, stop-after-repeat",
						"error",
					);
					return;
				}
				nextAction = requestedAction;
			} else if (ctx.hasUI) {
				const labels = ACTIONS.map(
					(value) => `${value === action ? "●" : "○"} ${ACTION_LABELS[value]}`,
				);
				const selected = await ctx.ui.select("Codex cyber warnings", labels);
				const index = selected ? labels.indexOf(selected) : -1;
				if (index < 0) return;
				nextAction = ACTIONS[index];
			} else {
				ctx.ui.notify(`Codex cyber-warning action: ${action}`, "info");
				return;
			}

			action = nextAction;
			warnedTurns = 0;
			await updateCodexConfig("cyberWarningAction", action);
			ctx.ui.notify(`Codex cyber-warning action: ${action}`, "info");
		},
	});

	pi.on("session_start", () => resetSessionState());
	pi.on("session_shutdown", () => resetSessionState());
	pi.on("model_select", () => resetSessionState());
	pi.on("turn_start", (_event, ctx) => {
		activeContext = isCodexGpt(ctx) ? ctx : undefined;
		requestedModel = activeContext?.model?.id;
		countedCurrentTurn = false;
		abortingCurrentTurn = false;
		warningKeys.clear();
	});

	const handleResponseHeaders = (
		headers: Record<string, string>,
		ctx: ExtensionContext,
	): void => {
		if (!isCodexGpt(ctx)) return;
		const serverModel = getServerModelFromResponseHeaders(headers);
		if (serverModel) handleServerModel(ctx, serverModel);
	};

	const handleBodyEvent = (
		event: SseBodyEvent,
		ctxOverride?: ExtensionContext,
	): void => {
		// activeContext is only ever assigned from a Codex GPT context.
		const ctx = ctxOverride ?? activeContext;
		if (!ctx || !isCodexGpt(ctx)) return;

		const serverModel = getServerModelFromBodyEvent(event);
		if (serverModel) handleServerModel(ctx, serverModel);
		if (hasTrustedAccessForCyberRecommendation(event)) {
			notifyWarning(
				ctx,
				TRUSTED_ACCESS_WARNING_KEY,
				`${codexProviderLabel(ctx.model?.provider)} cyber warning: repeated cybersecurity-risk flags enabled additional safety checks. Trusted Access for Cyber or different authentication may be required.`,
			);
		}
	};

	pi.on("after_provider_response", (event, ctx) => {
		handleResponseHeaders(event.headers, ctx);
	});

	return { handleResponseHeaders, handleBodyEvent };
}
