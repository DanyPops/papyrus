import { TASK_WIDGET_ACTIVE_LIMIT } from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { TaskGraph } from "../../src/task-service.ts";

export interface TaskWidgetRow {
	task: Artifact;
	depth: number;
	hasActiveChildren: boolean;
}

export interface TaskWidgetProjection {
	active: TaskWidgetRow[];
	activeTotal: number;
	total: number;
}

/** Keep active work in containment order; /tasks owns full graph navigation. */
export function buildTaskWidgetProjection(
	graph: TaskGraph,
	activeLimit = TASK_WIDGET_ACTIVE_LIMIT,
): TaskWidgetProjection {
	const visibleNodes = graph.nodes.filter((node) => node.task.status !== "deleted");
	const byId = new Map(visibleNodes.map((node) => [node.task.id, node]));
	const visited = new Set<string>();
	const ordered: TaskWidgetRow[] = [];

	const visit = (id: string, activeDepth: number): void => {
		if (visited.has(id)) return;
		const node = byId.get(id);
		if (!node) return;
		visited.add(id);
		const active = node.task.status === "active";
		if (active) ordered.push({ task: node.task, depth: activeDepth, hasActiveChildren: false });
		const childDepth = active ? activeDepth + 1 : activeDepth;
		for (const childId of node.childIds) visit(childId, childDepth);
	};

	for (const rootId of graph.rootIds) visit(rootId, 0);
	for (const node of visibleNodes) visit(node.task.id, 0);
	for (let index = 0; index < ordered.length - 1; index++) {
		ordered[index]!.hasActiveChildren = ordered[index + 1]!.depth > ordered[index]!.depth;
	}
	const active = ordered.slice(0, Math.max(0, activeLimit));
	return {
		active,
		activeTotal: ordered.length,
		total: visibleNodes.length,
	};
}
