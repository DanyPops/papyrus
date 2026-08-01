import type { Logger } from "@danypops/vehicle-server/logging";

export type LogLevel = "info" | "warn" | "error";

/** Credential-safe structured daemon event. Callers must pass bounded, non-sensitive fields. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, component: "papyrus-daemon", event, ...fields }));
}

/**
 * Adapts logEvent to @danypops/vehicle-server's Logger interface (debug/
 * info/warn/error), so createVehicleHttpApp's own failure logging lands
 * through this daemon's one existing structured-log sink instead of
 * introducing a second logging system. debug is a no-op -- this daemon's
 * own logEvent never had a debug level, and none of its existing output
 * needs one.
 */
export function vehicleLogger(): Logger {
	return {
		debug() {},
		info: (msg, fields) => logEvent("info", msg, fields),
		warn: (msg, fields) => logEvent("warn", msg, fields),
		error: (msg, fields) => logEvent("error", msg, fields),
	};
}
