import type { DisplayGraph, DisplayGraphEdge } from "./domain/display-graph.ts";
import { projectTaskExecution, type TaskExecutionState } from "./task-execution.ts";
import type { TaskGraph } from "./task-service.ts";

export type TaskGraphView = "execution" | "dependencies" | "composition";

const EXECUTION_GLYPHS: Record<TaskExecutionState, string> = {
	todo: "○",
	"in-progress": "●",
	review: "◆",
	rejected: "▲",
	done: "■",
	canceled: "×",
	ready: "◇",
	blocked: "○",
	invalid: "!",
};

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
		if (view === "execution" || view === "dependencies") {
			for (const dependencyId of node.dependencyIds) {
				addEdge({ from: dependencyId, to: node.task.id, label: "unlocks" });
			}
		} else {
			for (const childId of node.childIds) addEdge({ from: node.task.id, to: childId });
		}
	}

	const connected = view === "execution"
		? new Set(graph.nodes.map((node) => node.task.id))
		: new Set(edges.flatMap((edge) => [edge.from, edge.to]));
	const nodes = view === "execution"
		? projectTaskExecution(graph).nodes.map((node) => ({
			id: node.id,
			label: `${node.active ? "▶ " : ""}${EXECUTION_GLYPHS[node.state]} ${node.title} · ${node.layer === null ? "no layer" : `layer ${node.layer + 1}`} · ${node.state}`,
			status: node.state,
		}))
		: graph.nodes
			.filter((node) => connected.has(node.task.id))
			.map((node) => ({ id: node.task.id, label: node.task.title, status: node.task.status }));
	return {
		direction: "TD",
		nodes,
		edges: edges.filter((edge) => connected.has(edge.from) && connected.has(edge.to)),
	};
}
