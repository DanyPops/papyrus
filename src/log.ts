export type LogLevel = "info" | "warn" | "error";

/** Credential-safe structured daemon event. Callers must pass bounded, non-sensitive fields. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, component: "papyrus-daemon", event, ...fields }));
}
