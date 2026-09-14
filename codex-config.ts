import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(getAgentDir(), "codex-gateway.json");

export async function readCodexConfig(): Promise<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export async function updateCodexConfig(
	key: string,
	value: unknown,
): Promise<void> {
	const config = await readCodexConfig();
	const path = key.split(".");
	let target = config;
	for (const segment of path.slice(0, -1)) {
		const current = target[segment];
		target[segment] = current && typeof current === "object" && !Array.isArray(current)
			? current
			: {};
		target = target[segment] as Record<string, unknown>;
	}
	target[path.at(-1)!] = value;
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
