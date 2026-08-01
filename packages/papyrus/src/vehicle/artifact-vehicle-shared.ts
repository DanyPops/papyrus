/**
 * Shared schema helpers and name->id resolution for every per-domain
 * VehicleRegistry projection (notes-vehicle.ts, rules-vehicle.ts, docs-vehicle.ts,
 * artifact-trash-vehicle.ts).
 */
import { defineVehicleSchema, type VehicleSchemaCodec, type VehicleContentBlock } from "@danypops/vehicle-core";
import type { Artifact } from "../domain/artifact.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { TaskExecutionPlan } from "../task-execution.ts";

/**
 * VehicleRegistry only ever calls a schema's own safeParse -- jsonSchema is
 * descriptive metadata surfaced to a client/Pi projection, never itself
 * enforced at runtime -- so a declared `enum` has to be checked here for
 * real, or it's a documentation gesture, not an honest contract.
 */
export function looseObjectSchema(properties: Record<string, { type: string; enum?: readonly string[] }>, required: readonly string[] = []): VehicleSchemaCodec<Record<string, unknown>> {
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

/** A known LLM tool-calling quirk: a nested-object field arrives JSON-stringified rather than as a real object. Mutates input[key] in place when it's a string, leaves it untouched otherwise. */
export function normalizeJsonEncodedField(input: Record<string, unknown>, key: string): void {
	const value = input[key];
	if (typeof value !== "string") return;
	try {
		input[key] = JSON.parse(value);
	} catch {
		throw new Error(`${key} must be valid JSON`);
	}
}

/** Exact match semantics as the Pi-extension helper this replaces (domain-tools.ts's matchArtifactByName) -- case-insensitive exact title match, refuses to guess between ambiguous matches. */
export function matchArtifactByName(candidates: readonly Artifact[], name: string): string {
	const needle = name.trim().toLowerCase();
	const matches = candidates.filter((artifact) => artifact.title.trim().toLowerCase() === needle);
	if (matches.length === 0) throw new Error(`no artifact named "${name}" found in this scope`);
	if (matches.length > 1) {
		throw new Error(`${matches.length} artifacts are named "${name}": ${matches.map((a) => `${a.title} (${a.id})`).join(", ")} -- use id to disambiguate`);
	}
	return matches[0]!.id;
}

/**
 * Resolves a name to an id, retrying against `fetchWidened` (an unscoped/cross-project
 * search) only when `fetchCandidates` finds nothing. Owns the match-or-widen control
 * flow only -- the caller supplies its own scoped/widened list calls, since scoping
 * differs per domain. Omit `fetchWidened` when there is no wider scope to retry.
 */
export function resolveArtifactIdWidened(name: string, fetchCandidates: () => readonly Artifact[], fetchWidened?: () => readonly Artifact[]): string {
	try {
		return matchArtifactByName(fetchCandidates(), name);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("no artifact named") || !fetchWidened) throw error;
		return matchArtifactByName(fetchWidened(), name);
	}
}

/** Synchronous equivalent of pi-papyrus's own artifactLabelsById -- server-side, a direct ArtifactStore.get() replaces the extra RPC round-trip that helper needed client-side. Disambiguates same-titled artifacts by appending their id. */
export function labelsById(artifacts: ArtifactStore, ids: readonly string[]): Map<string, string> {
	const uniqueIds = [...new Set(ids)];
	const resolved = uniqueIds.map((id) => artifacts.get(id)).filter((artifact): artifact is Artifact => artifact !== null);
	const titleCounts = new Map<string, number>();
	for (const artifact of resolved) titleCounts.set(artifact.title, (titleCounts.get(artifact.title) ?? 0) + 1);
	return new Map(resolved.map((artifact) => [artifact.id, (titleCounts.get(artifact.title) ?? 0) > 1 ? `${artifact.title} (${artifact.id})` : artifact.title]));
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
export function buildWorkflowRunContent(artifacts: ArtifactStore, headline: string, input: WorkflowRunNarrativeInput, extraLines: readonly string[] = []): VehicleContentBlock {
	const nodeById = new Map(input.execution.nodes.map((node) => [node.id, node]));
	const rootLabels = input.rootTaskIds.map((id) => nodeById.get(id)?.title ?? "unknown task");
	const createdLabels = labelsById(artifacts, [...input.created.docs, ...input.created.rules]);
	const titleCounts = new Map<string, number>();
	for (const node of input.execution.nodes) titleCounts.set(node.title, (titleCounts.get(node.title) ?? 0) + 1);
	const executionLines = input.execution.nodes
		.map((node) => ((titleCounts.get(node.title) ?? 0) > 1 ? `  [${node.state}] ${node.title} (${node.id})` : `  [${node.state}] ${node.title}`))
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
