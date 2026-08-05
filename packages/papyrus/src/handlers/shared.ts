/**
 * Shared schema helpers and name->id resolution for every per-domain
 * VehicleRegistry projection (notes-vehicle.ts, rules-vehicle.ts, docs-vehicle.ts,
 * artifact-trash-vehicle.ts).
 */
import { defineVehicleSchema, type VehicleContentBlock, VehicleError, type VehicleSchemaCodec } from "@danypops/vehicle-core";
import type { Artifact } from "../domain/artifact.ts";
import { PlaybookCompositionError } from "../playbook/playbook-definition.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import { InvalidSessionSecretError } from "../session-identity-service.ts";
import { TaskDependencyCycleError, TaskExecutionBoundExceededError, type TaskExecutionPlan } from "../task/task-execution.ts";

/**
 * VehicleRegistry only ever calls a schema's own safeParse -- jsonSchema is
 * descriptive metadata surfaced to a client/Pi projection, never itself
 * enforced at runtime -- so a declared `enum` has to be checked here for
 * real, or it's a documentation gesture, not an honest contract.
 */
export function looseObjectSchema(
	properties: Record<string, { type: string; enum?: readonly string[] }>,
	required: readonly string[] = [],
): VehicleSchemaCodec<Record<string, unknown>> {
	return defineVehicleSchema<Record<string, unknown>>({
		jsonSchema: { type: "object", properties, required: [...required], additionalProperties: false },
		safeParse(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return { success: false, issues: [{ path: [], message: "input must be an object" }] };
			}
			const input = value as Record<string, unknown>;
			for (const key of required) {
				if (!(key in input)) return { success: false, issues: [{ path: [key], message: `${key} is required` }] };
			}
			for (const [key, schema] of Object.entries(properties)) {
				if (!schema.enum || !(key in input)) continue;
				if (!schema.enum.includes(input[key] as string)) {
					return { success: false, issues: [{ path: [key], message: `${key} must be one of ${schema.enum.join(", ")}` }] };
				}
			}
			return { success: true, value: input };
		},
	});
}

export const passthroughOutput: VehicleSchemaCodec<unknown> = defineVehicleSchema<unknown>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value }),
});

export const stringProp = { type: "string" } as const;
export const numberProp = { type: "number" } as const;

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
