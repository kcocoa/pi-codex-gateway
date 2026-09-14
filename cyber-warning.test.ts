import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CyberWarningAction } from "./cyber-warning-policy.ts";

// bun test does not auto-resolve Pi's packages; point the config module at a
// throwaway agent directory before importing the module under test.
const agentDir = await mkdtemp(join(import.meta.dir, ".cyber-warning-test-"));
mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDir,
}));

const { registerCyberWarningSupport } = await import("./cyber-warning.ts");

afterAll(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
	} as unknown as Parameters<typeof registerCyberWarningSupport>[0];
	return {
		pi,
		commands,
		async emit(name: string, event: unknown, ctx: unknown) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function createContext() {
	const notify = mock((_message: string, _level?: string) => undefined);
	const abort = mock(() => undefined);
	return {
		ctx: {
			model: { provider: "openai-codex", id: "gpt-5.4" },
			ui: { notify },
			isIdle: () => false,
			abort,
		},
		notify,
		abort,
	};
}

async function setup(action: CyberWarningAction) {
	const harness = createHarness();
	const support = await registerCyberWarningSupport(harness.pi, {
		initialAction: action,
	});
	return { harness, support };
}

const RESPONSE_CREATED = { type: "response.created", response: { id: "resp_1" } };
const RESPONSE_COMPLETED = {
	type: "response.completed",
	response: { id: "resp_1" },
};
const TRUSTED_ACCESS_METADATA = {
	type: "response.metadata",
	metadata: { openai_verification_recommendation: ["trusted_access_for_cyber"] },
};

describe("Cyber warning attribution", () => {
	it("aborts the turn for a warning during an in-flight response", async () => {
		const { harness, support } = await setup("stop");
		const { ctx, notify, abort } = createContext();
		await harness.emit("turn_start", { type: "turn_start" }, ctx);

		support.handleBodyEvent(RESPONSE_CREATED);
		support.handleBodyEvent(TRUSTED_ACCESS_METADATA);

		expect(abort).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Stopping the current turn",
		);
	});

	it("warns without aborting when no response is in flight", async () => {
		const { harness, support } = await setup("stop");
		const { ctx, notify, abort } = createContext();
		await harness.emit("turn_start", { type: "turn_start" }, ctx);

		support.handleBodyEvent(TRUSTED_ACCESS_METADATA);

		expect(abort).not.toHaveBeenCalled();
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"not attributed to the active request",
		);
	});

	it("clears the in-flight flag on terminal events", async () => {
		const { harness, support } = await setup("stop");
		const { ctx, notify, abort } = createContext();
		await harness.emit("turn_start", { type: "turn_start" }, ctx);

		support.handleBodyEvent(RESPONSE_CREATED);
		support.handleBodyEvent(RESPONSE_COMPLETED);
		// Trailing event after the terminal event: late clone branch or
		// lingering WebSocket frame; must not abort.
		support.handleBodyEvent(TRUSTED_ACCESS_METADATA);

		expect(abort).not.toHaveBeenCalled();
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"not attributed to the active request",
		);
	});

	it("still aborts for attributed response-header warnings", async () => {
		const { harness } = await setup("stop");
		const { ctx, notify, abort } = createContext();
		await harness.emit("turn_start", { type: "turn_start" }, ctx);

		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: { "openai-model": "gpt-fallback" },
			},
			ctx,
		);

		expect(abort).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"requested gpt-5.4, but the server routed this turn to gpt-fallback",
		);
	});

	it("does not count unattributed warnings toward stop-after-repeat", async () => {
		const { harness, support } = await setup("stop-after-repeat");
		const { ctx, notify, abort } = createContext();
		await harness.emit("turn_start", { type: "turn_start" }, ctx);

		support.handleBodyEvent(TRUSTED_ACCESS_METADATA);
		expect(abort).not.toHaveBeenCalled();
		expect(notify.mock.calls.at(-1)?.[0]).not.toContain("Warned turn");
	});
});
