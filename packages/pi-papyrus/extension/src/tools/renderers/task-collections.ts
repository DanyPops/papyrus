import { TASK_EXECUTION_MAX_EDGES, TASK_EXECUTION_MAX_NODES, TASK_LIST_PAGE_MAX_LIMIT, type TaskNode } from "@danypops/papyrus";
import { type ArtifactListToolDetails, createArtifactListDetails } from "../../tool-rendering/render-model/artifact.ts";
import { createGraphDetails, type GraphToolDetails, type ToolGraphEdge } from "../../tool-rendering/render-model/graph.ts";
import { isRecord } from "../../tool-rendering/render-model/shared.ts";
import { isArtifact, isArtifactArray } from "./shared.ts";

function identifiers(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= TASK_EXECUTION_MAX_NODES &&
		value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 500)
	);
}

function graphNode(value: unknown): value is TaskNode {
	return (
		isRecord(value) &&
		isArtifact(value.task) &&
		identifiers(value.parentIds) &&
		identifiers(value.childIds) &&
		identifiers(value.dependencyIds)
	);
}

/** Projects one cursor page while keeping its continuation token in the operation result only. */
export function taskPagePresentation(output: unknown): ArtifactListToolDetails | undefined {
	if (!isRecord(output) || !Array.isArray(output.items) || output.items.length > TASK_LIST_PAGE_MAX_LIMIT || !isArtifactArray(output.items))
		return undefined;
	if (
		output.nextCursor !== undefined &&
		(typeof output.nextCursor !== "string" || output.nextCursor.length === 0 || output.nextCursor.length > 16384)
	)
		return undefined;
	return { ...createArtifactListDetails("tasks.list_page", output.items), hasMore: output.nextCursor !== undefined };
}

/** Projects selected tasks and their typed relationships into a bounded hierarchy. */
export function taskGraphPresentation(output: unknown): GraphToolDetails | undefined {
	if (
		!isRecord(output) ||
		!Array.isArray(output.nodes) ||
		output.nodes.length > TASK_EXECUTION_MAX_NODES ||
		!identifiers(output.rootIds) ||
		!output.nodes.every(graphNode)
	)
		return undefined;
	const edges = new Map<string, ToolGraphEdge>();
	let linkCount = 0;
	for (const node of output.nodes) {
		linkCount += node.parentIds.length + node.childIds.length + node.dependencyIds.length;
		if (linkCount > TASK_EXECUTION_MAX_EDGES * 3) return undefined;
		const add = (from: string, relation: string, to: string) => {
			edges.set(JSON.stringify([from, relation, to]), { from, relation, to });
		};
		for (const parent of node.parentIds) add(parent, "contains", node.task.id);
		for (const child of node.childIds) add(node.task.id, "contains", child);
		for (const dependency of node.dependencyIds) add(dependency, "unlocks", node.task.id);
	}
	return createGraphDetails(
		"tasks.graph",
		output.nodes.map((node) => node.task),
		[...edges.values()],
	);
}
