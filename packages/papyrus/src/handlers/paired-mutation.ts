/** Vehicle-operation-definer DSL (createOperationDefiner) and the paired add/remove mutation shape built on top of it (definePairedMutation). */
import { bindVehicleOperation, defineVehicleOperation, type VehicleLimits, type VehicleOperationContext } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { looseObjectSchema, passthroughOutput } from "./operation-schema.ts";

export type OperationSchemaProperties = Record<
	string,
	{ type: string | readonly string[]; enum?: readonly string[]; description?: string; [key: string]: unknown }
>;

export type DefineOperation = (
	action: string,
	description: string,
	effect: "read" | "local-write",
	properties: OperationSchemaProperties,
	required: readonly string[],
	resolve: (input: Record<string, unknown>) => Record<string, unknown>,
	execute?: (input: Record<string, unknown>, context: VehicleOperationContext<Record<string, unknown>>) => unknown,
	/**
	 * Overrides this one operation's own Vehicle transport limits, distinct from every other
	 * operation this same createOperationDefiner call produces. For an operation that shells out
	 * to and waits on a real external command (e.g. tasks.run_gates/tasks.complete) rather than an
	 * instant CRUD read/write -- see handlers/tasks.ts's GATE_OPERATION_LIMITS for the motivating
	 * case. Omit to keep the definer's own default limits, unchanged for every other action.
	 */
	limits?: VehicleLimits,
) => void;

const STANDARD_OPERATION_LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

/**
 * Every *-vehicle.ts handler wires up the identical defineVehicleOperation +
 * bindVehicleOperation + registry.register triple per action, differing only in
 * owner/domain-prefix/permissions and (for tasks/playbooks) a real execute() override
 * in place of the default "call the wrapped module operation" behavior. One factory,
 * called once per domain, replaces that repetition.
 */
export function createOperationDefiner(
	registry: VehicleRegistry,
	owner: string,
	domain: string,
	permissions: readonly [string, string],
	defaultCall: (name: string, input: Record<string, unknown>) => unknown,
): DefineOperation {
	return (action, description, effect, properties, required, resolve, execute, limits) => {
		const operation = defineVehicleOperation({
			name: `${domain}.${action}`,
			version: 1,
			description,
			input: looseObjectSchema(properties, required),
			output: passthroughOutput,
			permissions: [...permissions],
			effect,
			idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
			limits: limits ?? STANDARD_OPERATION_LIMITS,
		});
		registry.register(
			owner,
			bindVehicleOperation(
				operation,
				() => async (context) =>
					(execute ?? ((input: Record<string, unknown>) => defaultCall(`${domain}.${action}`, input)))(resolve(context.input), context),
			),
		);
	};
}

export interface PairedMutationFieldSpec {
	idProp: string;
	nameProp: string;
}

/**
 * depend/undepend and contain/uncontain (tasks-vehicle.ts, playbooks-vehicle.ts) share
 * one shape: two id-or-name fields resolved the same way for both the add and the
 * remove action, differing only in action name/description. One call replaces two
 * near-identical define() invocations.
 */
export function definePairedMutation(
	define: DefineOperation,
	first: PairedMutationFieldSpec,
	second: PairedMutationFieldSpec,
	properties: OperationSchemaProperties,
	required: readonly string[],
	resolveId: (input: Record<string, unknown>, idProp: string, nameProp: string) => string,
	add: { action: string; description: string },
	remove: { action: string; description: string },
): void {
	const resolve = (input: Record<string, unknown>): Record<string, unknown> => ({
		...input,
		[first.idProp]: resolveId(input, first.idProp, first.nameProp),
		[second.idProp]: resolveId(input, second.idProp, second.nameProp),
	});
	define(add.action, add.description, "local-write", properties, required, resolve);
	define(remove.action, remove.description, "local-write", properties, required, resolve);
}
