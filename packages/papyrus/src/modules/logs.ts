/**
 * modules/logs.ts — the `log` domain as a registered Papyrus-native module.
 *
 * Deliberately self-contained: does not import artifact/task/rule/playbook infrastructure --
 * logs never touch the Artifact graph directly (see src/domain/log-entry.ts's own module
 * comment on why `log` is not an Artifact kind).
 */
import type { JsonValue, LogLevel } from "../log/log-entry.ts";
import type { Logs } from "../log/log-service.ts";
import type { OperationDefinition } from "../module-registry.ts";
import { type OperationInput, optionalNumber, optionalString, string } from "./operation-input.ts";

const MODULE_ID = "logs";

function isJsonValue(value: unknown): value is JsonValue {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		Array.isArray(value) ||
		typeof value === "object"
	);
}

function optionalFields(input: OperationInput, key: string): JsonValue | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (!isJsonValue(value)) throw new Error(`${key} must be JSON-serializable`);
	return value;
}

/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const LOGS_OPERATION_NAMES = ["logs.append", "logs.query"] as const;

/** Registers every logs.* operation against one Logs instance. */
export function logsOperations(logs: Logs): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("logs.append", (input: OperationInput) =>
			logs.append({
				sourceId: string(input, "source_id"),
				sourceLabel: optionalString(input, "source_label"),
				projectRoot: optionalString(input, "project_root") ?? null,
				level: string(input, "level") as LogLevel,
				message: string(input, "message"),
				fields: optionalFields(input, "fields"),
				operationId: string(input, "operation_id"),
				sessionId: optionalString(input, "session_id"),
				occurredAt: optionalString(input, "occurred_at"),
			}),
		),
		define("logs.query", (input: OperationInput) =>
			logs.query({
				sourceId: string(input, "source_id"),
				since: optionalString(input, "since"),
				level: optionalString(input, "level") as LogLevel | undefined,
				limit: optionalNumber(input, "limit"),
			}),
		),
	];
}
