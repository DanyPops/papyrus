import { TASK_WIDGET_OPEN_LIMIT } from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { TaskGraph } from "../../src/task-service.ts";

export interface TaskWidgetRow {
	task: Artifact;
	depth: number;
	hasOpenChildren: boolean;
	active: boolean;
}

export interface TaskWidgetProjection {
	rows: TaskWidgetRow[];
	openTotal: number;
	total: number;
}

function isOpen(task: Artifact): boolean {
	return task.status !== "done" && task.status !== "canceled";
}

/** Keep bounded actionable work in containment order while always retaining active focus. */
export function buildTaskWidgetProjection(
	graph: TaskGraph,
	openLimit = TASK_WIDGET_OPEN_LIMIT,
): TaskWidgetProjection {
	const byId = new Map(graph.nodes.map((node) => [node.task.id, node]));
	const visited = new Set<string>();
	const ordered: TaskWidgetRow[] = [];

	const visit = (id: string, openDepth: number): void => {
		if (visited.has(id)) return;
		const node = byId.get(id);
		if (!node) return;
		visited.add(id);
		const open = isOpen(node.task);
		if (open) ordered.push({ task: node.task, depth: openDepth, hasOpenChildren: false, active: node.active === true });
		const childDepth = open ? openDepth + 1 : openDepth;
		for (const childId of node.childIds) visit(childId, childDepth);
	};

	for (const rootId of graph.rootIds) visit(rootId, 0);
	for (const node of graph.nodes) visit(node.task.id, 0);
	for (let index = 0; index < ordered.length - 1; index++) {
		ordered[index]!.hasOpenChildren = ordered[index + 1]!.depth > ordered[index]!.depth;
	}

	const limit = Math.max(0, openLimit);
	let rows = ordered.slice(0, limit);
	const active = ordered.find((row) => row.active);
	if (active && !rows.some((row) => row.task.id === active.task.id) && limit > 0) {
		rows = [...rows.slice(0, Math.max(0, limit - 1)), active]
			.sort((left, right) => ordered.indexOf(left) - ordered.indexOf(right));
	}
	return { rows, openTotal: ordered.length, total: graph.nodes.length };
}
