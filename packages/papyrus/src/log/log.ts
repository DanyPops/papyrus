/**
 * Structured daemon logging, now backed by `@danypops/vehicle-server/logging` (pino) instead of a
 * hand-rolled `console.error(JSON.stringify(...))` -- gains real level filtering (including a real
 * debug level this daemon previously had no way to emit at all) and a destination injectable for
 * tests, matching jittor/src/log.ts's already-migrated shape exactly. One deliberate, disclosed
 * shape change from the old bespoke format: the event name is now pino's `msg` field rather than a
 * separate `event` field, matching daemon-kit's shared convention across every migrated daemon.
 * `component`/`level`/`timestamp` and credential-safety (callers still must pass only bounded,
 * non-sensitive fields; @danypops/vehicle-server/logging's own default redact list also catches any
 * credential-shaped field that slips in regardless) are unchanged.
 */
import { createLogger, type Logger, type LogLevel as VehicleLogLevel } from "@danypops/vehicle-server/logging";

export type LogLevel = Extract<VehicleLogLevel, "info" | "warn" | "error">;

/**
 * Pinned to `console.error` -- rather than `createLogger`'s own default of a raw fd 2 write via
 * `pino.destination(2)`, which bypasses `console.error` entirely -- so existing tooling/tests that
 * intercept `console.error` keep working unchanged (matches jittor/src/log.ts's own reasoning).
 * Also satisfies @danypops/vehicle-server's own `Logger` port directly wherever one is needed (e.g.
 * `createVehicleHttpApp`'s failure logging in daemon.ts), replacing the old `vehicleLogger()`
 * adapter now that this logger already natively implements the full debug/info/warn/error surface.
 */
export const logger: Logger = createLogger("papyrus-daemon", {
	destination: {
		write: (chunk: string) => {
			console.error(chunk.replace(/\n$/, ""));
			return true;
		},
	},
});

/** Credential-safe structured daemon event. Callers must pass bounded, non-sensitive fields. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	logger[level](event, fields);
}
