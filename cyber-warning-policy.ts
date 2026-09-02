export type CyberWarningAction = "warn" | "stop" | "stop-after-repeat";

export const REPEATED_WARNING_LIMIT = 2;
export const TRUSTED_ACCESS_WARNING_KEY = "trusted-access-for-cyber";

export function shouldStopCyberWarning(
	action: CyberWarningAction,
	warnedTurns: number,
): boolean {
	return (
		action === "stop" ||
		(action === "stop-after-repeat" && warnedTurns >= REPEATED_WARNING_LIMIT)
	);
}

export function serverModelWarningKey(
	requestedModel: string,
	serverModel: string,
): string {
	return `reroute:${requestedModel.toLowerCase()}:${serverModel.toLowerCase()}`;
}
