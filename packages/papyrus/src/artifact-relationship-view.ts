import type { Artifact } from "./domain/artifact.ts";
import type { DisplayGraph, DisplayGraphEdge, DisplayGraphNode } from "./domain/display-graph.ts";
import { fallbackLabel } from "./task-relationship-view.ts";

/**
 * The generic-artifact counterpart to projectTaskRelationships: unlike a Task, which already
 * has its containing TaskGraph's real titles in memory, a generic Doc/Rule/Skill/Playbook only
 * has raw edge id pairs (artifact.show's tree fetch never resolves neighbor titles -- see
 * ops.ts getArtifact). Reuses the same fallbackLabel heuristic rather than adding a network
 * round-trip per neighbor, which would turn a rendering concern into a new daemon-adjacent one.
 */
export function projectArtifactRelationships(artifact: Artifact): DisplayGraph {
	const edges: DisplayGraphEdge[] = (artifact.edges ?? []).map((edge) => ({ from: edge.from, to: edge.to, label: edge.relation }));
	const nodeIds = new Set<string>();
	for (const edge of edges) {
		nodeIds.add(edge.from);
		nodeIds.add(edge.to);
	}
	const nodes: DisplayGraphNode[] = [...nodeIds].map((id) => id === artifact.id
		? { id, label: artifact.title, status: artifact.status }
		: { id, label: fallbackLabel(id) });
	return { direction: "LR", nodes, edges };
}
