/**
 * Cross-domain artifact name/id resolution and workflow-run narrative building, split out of
 * handlers/shared.ts as part of a SOLID-audit-driven decomposition (see Doc "Modularity playbook:
 * building-block-shaped TypeScript modules for papyrus/pi-papyrus" and the "handlers/shared.ts
 * split" child of "Epic: Modularize papyrus/pi-papyrus god-files into building-block modules").
 */
import { type VehicleContentBlock, VehicleError } from "@danypops/vehicle-core";
import type { Artifact } from "../artifact/artifact.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { TaskExecutionPlan } from "../task/task-execution.ts";
import { validationError } from "./operation-schema.ts";

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
