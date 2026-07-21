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

function node(artifact: Artifact, parentIds: string[] = [], childIds: string[] = [], active = false): TaskNode {
	return { task: artifact, active, parentIds, childIds, dependencyIds: [] };
}

const graph: TaskGraph = {
	nodes: [
		node(task("parent", "Lifecycle parent", "in-progress"), [], ["child"]),
		node(task("child", "Focused child", "review"), ["parent"], [], true),
		node(task("todo", "Todo one", "todo")),
		node(task("done", "Done one", "done")),
		node(task("canceled", "Canceled one", "canceled")),
	],
	rootIds: ["parent", "todo", "done", "canceled"],
};

describe("task widget projection", () => {
	it("shows open parents and children in containment order with orthogonal focus", () => {
		const projection = buildTaskWidgetProjection(graph, 3);

		expect(projection.rows.map(({ task, depth, hasOpenChildren, active }) => ({
			id: task.id, depth, hasOpenChildren, active,
		}))).toEqual([
			{ id: "parent", depth: 0, hasOpenChildren: true, active: false },
			{ id: "child", depth: 1, hasOpenChildren: false, active: true },
			{ id: "todo", depth: 0, hasOpenChildren: false, active: false },
		]);
		expect(projection.openTotal).toBe(3);
		expect(projection.total).toBe(5);
	});

	it("retains active focus when the open row bound would otherwise omit it", () => {
		const expanded: TaskGraph = {
			nodes: [
				node(task("first", "First", "todo")),
				node(task("second", "Second", "in-progress")),
				node(task("focused", "Focused", "rejected"), [], [], true),
			],
			rootIds: ["first", "second", "focused"],
		};
		const projection = buildTaskWidgetProjection(expanded, 2);

		expect(projection.rows.map((row) => row.task.id)).toEqual(["first", "focused"]);
		expect(projection.openTotal).toBe(3);
		expect(projection.rows.find((row) => row.active)?.task.id).toBe("focused");
	});

	it("projects parentCount from the DAG's actual parentIds, so a multi-parent task can be flagged rather than silently shown as single-parent", () => {
		const shared: TaskGraph = {
			nodes: [
				node(task("parent-a", "Parent A", "in-progress"), [], ["shared"]),
				node(task("parent-b", "Parent B", "in-progress"), [], ["shared"]),
				node(task("shared", "Shared child", "todo"), ["parent-a", "parent-b"], []),
			],
			rootIds: ["parent-a", "parent-b"],
		};
		const projection = buildTaskWidgetProjection(shared, 10);
		expect(projection.rows.find((row) => row.task.id === "shared")?.parentCount).toBe(2);
		expect(projection.rows.find((row) => row.task.id === "parent-a")?.parentCount).toBe(0);
	});

	it("returns no rows when every task is terminal", () => {
		const terminal: TaskGraph = {
			nodes: [node(task("done", "Done", "done")), node(task("canceled", "Canceled", "canceled"))],
			rootIds: ["done", "canceled"],
		};
		const projection = buildTaskWidgetProjection(terminal, 3);

		expect(projection.rows).toEqual([]);
		expect(projection.openTotal).toBe(0);
		expect(projection.total).toBe(2);
	});
});
