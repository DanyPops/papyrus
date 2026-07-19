import type { DisplayGraph, DisplayGraphEdge } from "./domain/display-graph.ts";
import type { TaskGraph } from "./task-service.ts";

export type TaskGraphView = "dependencies" | "composition";

export function projectTaskGraph(graph: TaskGraph, view: TaskGraphView): DisplayGraph {
	const edges: DisplayGraphEdge[] = [];
	const seen = new Set<string>();
	const addEdge = (edge: DisplayGraphEdge): void => {
		const key = `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		edges.push(edge);
	};

	for (const node of graph.nodes) {
		if (view === "dependencies") {
			for (const dependencyId of node.dependencyIds) {
				addEdge({ from: dependencyId, to: node.task.id, label: "unlocks" });
			}
		} else {
			for (const childId of node.childIds) addEdge({ from: node.task.id, to: childId });
		}
	}

	const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
	return {
		direction: "TD",
		nodes: graph.nodes
			.filter((node) => connected.has(node.task.id))
			.map((node) => ({ id: node.task.id, label: node.task.title, status: node.task.status })),
		edges: edges.filter((edge) => connected.has(edge.from) && connected.has(edge.to)),
	};
}
