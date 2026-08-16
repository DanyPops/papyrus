/**
 * batch.execute -- a generic fan-out over N independent operations in one Vehicle call, so a
 * caller doing N artifact mutations (e.g. renaming 45 tasks/docs) doesn't need N separate tool
 * round-trips. Reuses each item's existing single-operation validation/execute path unchanged:
 * a thin fan-out over registry.invoke() -- this same VehicleRegistry, self-referenced, so every
 * item goes through the exact same schema/permission/effect enforcement a direct call would --
 * not a parallel reimplementation of any domain's own update logic.
 *
 * Partial failure, not all-or-nothing: every item is attempted regardless of an earlier item's
 * own failure, and the response reports one {ok, result} or {ok, error} entry per item, in the
 * SAME order as the request -- an artifact-not-found on item 12 of 45 never rolls back or skips
 * items 1-11 or 13-45.
 *
 * Deliberately scoped to fan out N INDEPENDENT calls, nothing more. A caller whose own items are
 * NOT independent (e.g. item 2 needs item 1's just-created id) needs a genuinely different
 * feature (transactional/dependent-batch chaining) -- out of scope here.
 */
import { bindVehicleOperation, defineVehicleOperation, isVehicleError, type VehicleInvocationOptions } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { BATCH_MAX_ITEMS } from "../constants.ts";
import { looseObjectSchema, passthroughOutput, stringProp, validationError } from "./shared.ts";

const OWNER = "batch";
const LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000, maxRequestBytes: 262_144, maxResponseBytes: 1_048_576 };

export interface BatchItem {
	readonly op: string;
	readonly version?: number;
	readonly input: Record<string, unknown>;
}

export type BatchItemResult = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string };

/** Shared validation for both this file's own Vehicle-native registration and service.ts's
 * moduleRegistry/composition-root-facing "batch.execute" entry -- one bounds/shape check, not
 * two independently-drifting copies. */
export function parseBatchItems(input: Record<string, unknown>): BatchItem[] {
	const raw = input.items;
	if (!Array.isArray(raw) || raw.length === 0) throw validationError("items must be a non-empty array");
	if (raw.length > BATCH_MAX_ITEMS) throw validationError(`items cannot contain more than ${BATCH_MAX_ITEMS} entries`);
	return raw.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw validationError(`items[${index}] must be an object`);
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.op !== "string" || record.op.length === 0) throw validationError(`items[${index}].op is required`);
		if (record.version !== undefined && typeof record.version !== "number") {
			throw validationError(`items[${index}].version must be a number`);
		}
		if (record.input !== undefined && (typeof record.input !== "object" || record.input === null || Array.isArray(record.input))) {
			throw validationError(`items[${index}].input must be an object`);
		}
		return {
			op: record.op,
			version: record.version as number | undefined,
			input: (record.input as Record<string, unknown> | undefined) ?? {},
		};
	});
}

/** Turns any per-item failure (a real VehicleError, or an unexpected throw) into the same plain
 * message string every {ok:false, error} entry reports -- a caller reading the aggregate result
 * needs one consistent shape regardless of which layer the failure came from. */
export function batchItemErrorMessage(error: unknown): string {
	if (isVehicleError(error)) return error.message;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Registers batch.execute as a real VehicleOperation -- the path an actual Pi tool call
 * reaches. Each item is dispatched via registry.invoke() (this same registry, self-referenced),
 * propagating the OUTER batch call's own granted permissions/principal/correlation identity to
 * every item unchanged -- a caller with a narrower permission set than some item requires gets
 * that item reported as a normal {ok:false} permission-denied failure, never a silent escalation
 * granted by batch.execute's own (deliberately empty) permission requirement.
 */
export function registerBatchVehicleOperation(registry: VehicleRegistry): void {
	const operation = defineVehicleOperation({
		name: "batch.execute",
		version: 1,
		description:
			'Fans out N independent operations (each an existing {op, input} pair, e.g. {"op":"tasks.update","input":{"id":"...","title":"..."}}) in one call, so N artifact mutations don\'t need N separate tool round-trips. Every item is attempted regardless of another item\'s own failure; the response is {results: [{ok, result} | {ok, error}, ...]}, one entry per item, in request order. Not transactional and not for dependent items (e.g. one item needing another\'s just-created id) -- only for independent operations that would otherwise be called one at a time.',
		input: looseObjectSchema(
			{
				items: {
					type: "array",
					minItems: 1,
					maxItems: BATCH_MAX_ITEMS,
					description: "Each entry names an existing operation and its own input, exactly as a direct call would receive it.",
					items: {
						type: "object",
						properties: {
							op: stringProp,
							version: { type: "number" },
							input: { type: "object" },
						},
						required: ["op"],
						additionalProperties: false,
					},
				},
			},
			["items"],
		),
		output: passthroughOutput,
		// Deliberately empty: batch.execute itself gates nothing -- every fanned-out item is
		// re-checked against the caller's own real granted permissions via registry.invoke() below.
		permissions: [],
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(operation, () => async (context) => {
			const items = parseBatchItems(context.input as Record<string, unknown>);
			const propagated: VehicleInvocationOptions = {
				permissions: context.permissions,
				principal: context.principal,
				correlationId: context.correlationId,
				signal: context.signal,
			};
			const results: BatchItemResult[] = [];
			for (const item of items) {
				try {
					const result = await registry.invoke(item.op, item.version ?? 1, item.input, propagated);
					results.push({ ok: true, result });
				} catch (error) {
					results.push({ ok: false, error: batchItemErrorMessage(error) });
				}
			}
			return { results };
		}),
	);
}
