/**
 * Shared schema helpers and name->id resolution for every per-domain
 * VehicleRegistry projection (notes-vehicle.ts, rules-vehicle.ts, docs-vehicle.ts,
 * artifact-trash-vehicle.ts).
 */
import {
	bindVehicleOperation,
	defineVehicleOperation,
	defineVehicleSchema,
	type JsonSchema,
	type VehicleContentBlock,
	VehicleError,
	type VehicleLimits,
	type VehicleOperationContext,
	type VehicleSchemaCodec,
	type VehicleSchemaIssue,
} from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { Artifact } from "../artifact/artifact.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { PlaybookCompositionError } from "../playbook/playbook-definition.ts";
import { InvalidSessionSecretError } from "../session-identity/session-identity-service.ts";
import { TaskCreateIdempotencyConflictError } from "../stores/task-create-request-store.ts";
import { TaskDependencyCycleError, TaskExecutionBoundExceededError, type TaskExecutionPlan } from "../task/task-execution.ts";

interface OperationSchemaNode {
	readonly type?: string | readonly string[];
	readonly enum?: readonly unknown[];
	readonly properties?: Readonly<Record<string, OperationSchemaNode>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | OperationSchemaNode;
	/** A key not in `properties` is validated against the first pattern here whose RegExp matches it, instead of falling through to `additionalProperties` -- e.g. a free-form string-keyed map (tasks.create's checklist) uses `{"^.*$": entrySchema}` so a client-side JSON-Schema validator that reports `additionalProperties`-as-schema violations only as a generic top-level "must not have additional properties" (TypeBox's own real, confirmed behavior -- see vehicle-shell.ts's formatSchemaChildren for the matching tools_man rendering) instead descends into the real nested violation, matching an array's `items` precision. */
	readonly patternProperties?: Readonly<Record<string, OperationSchemaNode>>;
	readonly items?: OperationSchemaNode;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly description?: string;
	readonly [key: string]: unknown;
}

function schemaIssue(path: readonly (string | number)[], message: string): VehicleSchemaIssue[] {
	return [{ path, message }];
}

function matchesSchemaType(value: unknown, type: string): boolean {
	if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
	if (type === "array") return Array.isArray(value);
	if (type === "string") return typeof value === "string";
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	if (type === "integer") return typeof value === "number" && Number.isInteger(value);
	if (type === "boolean") return typeof value === "boolean";
	return true;
}

function validateSchemaValue(value: unknown, schema: OperationSchemaNode, path: readonly (string | number)[]): VehicleSchemaIssue[] {
	const label = path.length === 0 ? "input" : String(path.at(-1));
	const declaredTypes = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);
	const type = declaredTypes.find((candidate) => matchesSchemaType(value, candidate));
	if (declaredTypes.length > 0 && type === undefined) {
		const accepted = declaredTypes.map((candidate) =>
			candidate === "integer" ? "an integer" : `${candidate === "object" ? "an" : "a"} ${candidate}`,
		);
		return schemaIssue(path, `${label} must be ${accepted.join(" or ")}`);
	}
	if (type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return schemaIssue(path, `${label} must be an object`);
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in record)) {
				const acceptedShape = schema.description ? `; ${schema.description}` : "";
				return schemaIssue([...path, key], `${key} is required${acceptedShape}`);
			}
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (!(key in record)) continue;
			const issues = validateSchemaValue(record[key], child, [...path, key]);
			if (issues.length > 0) return issues;
		}
		for (const key of Object.keys(record)) {
			if (key in (schema.properties ?? {})) continue;
			const patternMatch = Object.entries(schema.patternProperties ?? {}).find(([pattern]) => new RegExp(pattern).test(key));
			if (patternMatch) {
				const issues = validateSchemaValue(record[key], patternMatch[1], [...path, key]);
				if (issues.length > 0) return issues;
				continue;
			}
			if (schema.additionalProperties === false) return schemaIssue([...path, key], `${key} is not allowed`);
			if (typeof schema.additionalProperties === "object") {
				const issues = validateSchemaValue(record[key], schema.additionalProperties, [...path, key]);
				if (issues.length > 0) return issues;
			}
		}
	} else if (type === "array") {
		const entries = value as unknown[];
		if (schema.minItems !== undefined && entries.length < schema.minItems) {
			return schemaIssue(path, `${label} must contain at least ${schema.minItems} item(s)`);
		}
		if (schema.maxItems !== undefined && entries.length > schema.maxItems) {
			return schemaIssue(path, `${label} cannot contain more than ${schema.maxItems} item(s)`);
		}
		if (schema.items) {
			for (const [index, entry] of entries.entries()) {
				const issues = validateSchemaValue(entry, schema.items, [...path, index]);
				if (issues.length > 0) return issues;
			}
		}
	} else if (type === "string") {
		const text = value as string;
		if (schema.minLength !== undefined && text.length < schema.minLength) {
			return schemaIssue(path, `${label} must contain at least ${schema.minLength} character(s)`);
		}
		if (schema.maxLength !== undefined && text.length > schema.maxLength) {
			return schemaIssue(path, `${label} cannot exceed ${schema.maxLength} character(s)`);
		}
	} else if (type === "number" || type === "integer") {
		const number = value as number;
		if (schema.minimum !== undefined && number < schema.minimum) {
			return schemaIssue(path, `${label} must be at least ${schema.minimum}`);
		}
		if (schema.maximum !== undefined && number > schema.maximum) {
			return schemaIssue(path, `${label} cannot exceed ${schema.maximum}`);
		}
	}
	if (schema.enum && !schema.enum.includes(value)) {
		return schemaIssue(path, `${label} must be one of ${schema.enum.join(", ")}`);
	}
	return [];
}

/** VehicleRegistry executes this codec before resolving or dispatching an operation. Keep the
 * recursive runtime checks aligned with the same JSON Schema clients and tools_man receive. */
export function looseObjectSchema(
	properties: Readonly<Record<string, OperationSchemaNode>>,
	required: readonly string[] = [],
): VehicleSchemaCodec<Record<string, unknown>> {
	const schema = { type: "object", properties, required: [...required], additionalProperties: false } as const;
	return defineVehicleSchema<Record<string, unknown>>({
		jsonSchema: schema as unknown as JsonSchema,
		safeParse(value) {
			const issues = validateSchemaValue(value, schema, []);
			return issues.length > 0 ? { success: false, issues } : { success: true, value: value as Record<string, unknown> };
		},
	});
}

export const passthroughOutput: VehicleSchemaCodec<unknown> = defineVehicleSchema<unknown>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value }),
});

export const stringProp = { type: "string" } as const;
export const numberProp = { type: "number" } as const;
export const booleanProp = { type: "boolean" } as const;

/**
 * A plain `throw new Error(...)` inside any resolve()/execute() step here is caught by
 * vehicle-registry.ts's generic dispatch and re-wrapped as VehicleError("handler-failed",
 * `${key} handler failed`, {category: "internal"}) -- built to catch a genuine crash, but
 * it can't distinguish that from an ordinary, expected validation/lookup failure, so it
 * discards the original message and category either way. Every guard clause and name
 * resolution below must throw a VehicleError directly so it passes through that dispatch
 * unchanged (vehicle-registry.ts only rewraps errors that are NOT already a VehicleError).
 */
export function validationError(message: string): VehicleError {
	return new VehicleError("validation-failed", message, { category: "validation" });
}

/**
 * tasks.focus/pause/unpause/clear_focus and playbooks.invoke all re-run
 * sessionIdentity.assertAuthorized(session_id, session_secret) directly, bypassing the guarded
 * tasks.focus operation (see modules/tasks.ts's guardFocusMutation and modules/playbooks.ts's own
 * doc comment) -- a real, registered session's own auth failure is an ordinary, expected outcome,
 * not an unexpected crash, so it must surface as its own classified VehicleError. Real incident:
 * this used to arrive only inside .cause of an opaque "... handler failed", invisible to a caller
 * that doesn't already know to dig for it. Anything else propagates unchanged, so vehicle-registry's
 * own secure-by-default handler-failed opacity still applies to a genuine unexpected crash.
 */
export function classifySessionAuthorization<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof InvalidSessionSecretError) {
			throw new VehicleError("invalid-session-secret", error.message, { category: "authorization" });
		}
		throw error;
	}
}

/**
 * A task execution graph (or a workflow/playbook run materializing one) that exceeds its own
 * node/edge/degree bound is an ordinary, expected capacity failure, not an unexpected crash --
 * must surface as its own classified VehicleError instead of vehicle-registry's generic
 * handler-failed. Shared by tasks-vehicle.ts (create/depend/contain/graph/plan/complete) and
 * playbooks-vehicle.ts (invoke, which materializes Tasks through the same shared engine).
 */
export function classifyTaskExecutionBounds<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof TaskExecutionBoundExceededError) {
			throw new VehicleError("task-execution-bound-exceeded", error.message, { category: "capacity" });
		}
		throw error;
	}
}

export function classifyTaskCreateIdempotency<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof TaskCreateIdempotencyConflictError) {
			throw new VehicleError("idempotency-key-conflict", error.message, { category: "conflict" });
		}
		throw error;
	}
}

/** A self-dependency or dependency-cycle rejection (tasks.depend/undepend/create) is an ordinary, expected validation failure, not an unexpected crash. */
export function classifyTaskDependencyCycles<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof TaskDependencyCycleError) {
			throw new VehicleError("task-dependency-cycle", error.message, { category: "validation" });
		}
		throw error;
	}
}

/** A Playbook's own composition tree (contains/depends_on nesting) is invalid -- a cycle, excessive depth/size, or conflicting argument types -- an ordinary, expected authoring mistake caught at playbooks.invoke/preview compile time, not an unexpected crash. */
export function classifyPlaybookComposition<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof PlaybookCompositionError) {
			throw new VehicleError("playbook-composition-invalid", error.message, { category: "validation" });
		}
		throw error;
	}
}

/** A known LLM tool-calling quirk: a nested-object field arrives JSON-stringified rather than as a real object. Mutates input[key] in place when it's a string, leaves it untouched otherwise. */
export function normalizeJsonEncodedField(input: Record<string, unknown>, key: string): void {
	const value = input[key];
	if (typeof value !== "string") return;
	try {
		input[key] = JSON.parse(value);
	} catch {
		throw validationError(`${key} must be valid JSON`);
	}
}

/** Exact match semantics as the Pi-extension helper this replaces (domain-tools.ts's matchArtifactByName) -- case-insensitive exact title match, refuses to guess between ambiguous matches. */
export function matchArtifactByName(candidates: readonly Artifact[], name: string): string {
	const needle = name.trim().toLowerCase();
	const matches = candidates.filter((artifact) => artifact.title.trim().toLowerCase() === needle);
	if (matches.length === 0) {
		throw new VehicleError("artifact-not-found", `no artifact named "${name}" found in this scope`, { category: "not_found" });
	}
	if (matches.length > 1) {
		throw new VehicleError(
			"artifact-name-ambiguous",
			`${matches.length} artifacts are named "${name}": ${matches.map((a) => `${a.title} (${a.alias})`).join(", ")} -- use id or alias to disambiguate`,
			{ category: "conflict" },
		);
	}
	return matches[0]!.id;
}

/**
 * Resolves a name to an id. Checks `artifacts.getByAlias` first -- a real, indexed,
 * globally-unique match, unlike title -- before falling back to today's scoped
 * title-based matching, retrying against `fetchWidened` (an unscoped/cross-project
 * search) only when `fetchCandidates` finds nothing. Owns the match-or-widen control
 * flow only -- the caller supplies its own scoped/widened list calls, since scoping
 * differs per domain. Omit `fetchWidened` when there is no wider scope to retry.
 */
export function resolveArtifactIdWidened(
	artifacts: ArtifactStore,
	name: string,
	fetchCandidates: () => readonly Artifact[],
	fetchWidened?: () => readonly Artifact[],
): string {
	const byAlias = artifacts.getByAlias(name.trim());
	if (byAlias) return byAlias.id;
	try {
		return matchArtifactByName(fetchCandidates(), name);
	} catch (error) {
		if (!(error instanceof VehicleError) || error.code !== "artifact-not-found" || !fetchWidened) throw error;
		return matchArtifactByName(fetchWidened(), name);
	}
}

/** Synchronous equivalent of pi-papyrus's own artifactLabelsById -- server-side, a direct ArtifactStore.get() replaces the extra RPC round-trip that helper needed client-side. Always suffixes the alias -- a short, meaningful, globally-unique reference, unlike the raw UUID it replaces. */
export function labelsById(artifacts: ArtifactStore, ids: readonly string[]): Map<string, string> {
	const uniqueIds = [...new Set(ids)];
	const resolved = uniqueIds.map((id) => artifacts.get(id)).filter((artifact): artifact is Artifact => artifact !== null);
	return new Map(resolved.map((artifact) => [artifact.id, `${artifact.title} (${artifact.alias})`]));
}

export interface WorkflowRunNarrativeInput {
	runId: string;
	created: { docs: readonly string[]; rules: readonly string[]; tasks: readonly string[] };
	rootTaskIds: readonly string[];
	execution: TaskExecutionPlan;
}

/**
 * Builds the model-facing `content` text for a workflow run result (ready roots, context docs,
 * scoped rules, an execution tree) directly, so the model reads a summary instead of the raw
 * execution DAG -- the same shape pi-papyrus's own hand-rolled playbooks tool built
 * client-side, now built once here where the run result is actually produced.
 */
export function buildWorkflowRunContent(
	artifacts: ArtifactStore,
	headline: string,
	input: WorkflowRunNarrativeInput,
	extraLines: readonly string[] = [],
): VehicleContentBlock {
	const nodeById = new Map(input.execution.nodes.map((node) => [node.id, node]));
	const rootLabels = input.rootTaskIds.map((id) => nodeById.get(id)?.title ?? "unknown task");
	const createdLabels = labelsById(artifacts, [...input.created.docs, ...input.created.rules]);
	const titleCounts = new Map<string, number>();
	for (const node of input.execution.nodes) titleCounts.set(node.title, (titleCounts.get(node.title) ?? 0) + 1);
	const executionLines = input.execution.nodes
		.map((node) =>
			(titleCounts.get(node.title) ?? 0) > 1 ? `  [${node.state}] ${node.title} (${node.id})` : `  [${node.state}] ${node.title}`,
		)
		.join("\n");
	const text = [
		headline,
		...extraLines,
		`Ready roots: ${rootLabels.join(", ") || "none"}.`,
		`Context docs: ${input.created.docs.map((id) => createdLabels.get(id) ?? "unknown document").join(", ") || "none"}.`,
		`Scoped rules: ${input.created.rules.map((id) => createdLabels.get(id) ?? "unknown rule").join(", ") || "none"}.`,
		...(executionLines ? ["Execution:", executionLines] : []),
	].join("\n");
	return { type: "text", text };
}

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
