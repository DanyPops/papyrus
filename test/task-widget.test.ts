import { describe, expect, it } from "bun:test";
import { buildTaskWidgetProjection } from "../extension/src/task-widget.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import type { TaskGraph, TaskNode } from "../src/task-service.ts";

function task(id: string, title: string, status: string): Artifact {
	return {
		id, title, status, kind: "task", subtype: "", body: "", labels: [], extra: {},
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function node(artifact: Artifact, parentIds: string[] = [], childIds: string[] = []): TaskNode {
	return { task: artifact, parentIds, childIds, dependencyIds: [] };
}

const rows = [
	task("active-1", "Active parent", "active"),
	task("pending-1", "Pending one", "pending"),
	task("done-1", "Done one", "done"),
	task("active-2", "Active child", "active"),
	task("deleted-1", "Deleted one", "deleted"),
];

const graph: TaskGraph = {
	nodes: [
		node(rows[0]!, [], ["active-2"]),
		node(rows[1]!),
		node(rows[2]!),
		node(rows[3]!, ["active-1"]),
		node(rows[4]!),
	],
	rootIds: ["active-1", "pending-1", "done-1", "deleted-1"],
};

describe("task widget projection", () => {
	it("shows active parents and children in containment order", () => {
		const projection = buildTaskWidgetProjection(graph, 3);

		expect(projection.active.map(({ task, depth, hasActiveChildren }) => ({ id: task.id, depth, hasActiveChildren }))).toEqual([
			{ id: "active-1", depth: 0, hasActiveChildren: true },
			{ id: "active-2", depth: 1, hasActiveChildren: false },
		]);
		expect(projection.activeTotal).toBe(2);
		expect(projection.total).toBe(4);
		expect("hiddenTotal" in projection).toBe(false);
	});

	it("caps active rows while preserving the total active count", () => {
		const expanded: TaskGraph = {
			...graph,
			nodes: [
				...graph.nodes,
				node(task("active-3", "Active three", "active")),
				node(task("active-4", "Active four", "active")),
			],
			rootIds: [...graph.rootIds, "active-3", "active-4"],
		};
		const projection = buildTaskWidgetProjection(expanded, 2);

		expect(projection.active.map((row) => row.task.id)).toEqual(["active-1", "active-2"]);
		expect(projection.activeTotal).toBe(4);
	});

	it("does not leave floating indentation beneath an inactive parent", () => {
		const inactiveParent: TaskGraph = {
			nodes: [
				node(task("parent", "Pending parent", "pending"), [], ["child"]),
				node(task("child", "Active child", "active"), ["parent"]),
			],
			rootIds: ["parent"],
		};

		expect(buildTaskWidgetProjection(inactiveParent).active[0]?.depth).toBe(0);
	});

	it("returns no task rows when nothing is active", () => {
		const inactive: TaskGraph = {
			...graph,
			nodes: graph.nodes.map((entry) => ({
				...entry,
				task: { ...entry.task, status: entry.task.status === "active" ? "pending" : entry.task.status },
			})),
		};
		const projection = buildTaskWidgetProjection(inactive, 3);

		expect(projection.active).toEqual([]);
		expect(projection.activeTotal).toBe(0);
	});
});
