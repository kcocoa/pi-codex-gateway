import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(getAgentDir(), "codex.json");

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
	config[key] = value;
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
