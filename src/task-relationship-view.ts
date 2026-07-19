import type { Artifact, ArtifactEdge } from "./domain/artifact.ts";
import type { DisplayGraph, DisplayGraphEdge, DisplayGraphNode } from "./domain/display-graph.ts";
import type { TaskGraph } from "./task-service.ts";

function normalizeEdge(edge: ArtifactEdge): DisplayGraphEdge {
	if (edge.relation === "part_of") return { from: edge.to, to: edge.from };
	if (edge.relation === "depends_on") return { from: edge.to, to: edge.from, label: "unlocks" };
	if (edge.relation === "contains") return { from: edge.from, to: edge.to };
	return { from: edge.from, to: edge.to, label: edge.relation };
}

function fallbackLabel(id: string): string {
	return id.replace(/-[a-z0-9]{4}$/i, "").replaceAll("-", " ");
}

export function projectTaskRelationships(task: Artifact, graph?: TaskGraph): DisplayGraph {
	const taskNodes = new Map(graph?.nodes.map((node) => [node.task.id, node.task]) ?? []);
	taskNodes.set(task.id, task);
	const edges: DisplayGraphEdge[] = [];
	const seenEdges = new Set<string>();
	const nodeIds = new Set<string>();
	for (const artifactEdge of task.edges ?? []) {
		const edge = normalizeEdge(artifactEdge);
		const key = `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ""}`;
		if (!seenEdges.has(key)) {
			seenEdges.add(key);
			edges.push(edge);
		}
		nodeIds.add(edge.from);
		nodeIds.add(edge.to);
	}
	const nodes: DisplayGraphNode[] = [...nodeIds].map((id) => {
		const artifact = taskNodes.get(id);
		return artifact
			? { id, label: artifact.title, status: artifact.status }
			: { id, label: fallbackLabel(id) };
	});
	return { direction: "LR", nodes, edges };
}
