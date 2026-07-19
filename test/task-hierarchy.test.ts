import { describe, expect, it } from "bun:test";
import { buildTaskHierarchy } from "../extension/src/tasks.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import type { TaskGraph, TaskNode } from "../src/task-service.ts";

function task(id: string, title: string): Artifact {
	return {
		id,
		kind: "task",
		title,
		status: "todo",
		subtype: "",
		body: "",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function node(id: string, title: string, relationships: Partial<Omit<TaskNode, "task">> = {}): TaskNode {
	return {
		task: task(id, title),
		parentIds: relationships.parentIds ?? [],
		childIds: relationships.childIds ?? [],
		dependencyIds: relationships.dependencyIds ?? [],
	};
}

describe("task hierarchy projection", () => {
	it("renders tasks composed of tasks as an ordered hierarchy", () => {
		const graph: TaskGraph = {
			nodes: [
				node("child", "Build policy", { parentIds: ["root"], childIds: ["leaf"], dependencyIds: ["telemetry"] }),
				node("root", "Router epic", { childIds: ["child"] }),
				node("leaf", "Add hysteresis", { parentIds: ["child"] }),
				node("telemetry", "Collect telemetry"),
			],
			rootIds: ["root", "telemetry"],
		};

		const hierarchy = buildTaskHierarchy(graph);

		expect(hierarchy.map(({ task, depth }) => [task.id, depth])).toEqual([
			["root", 0],
			["child", 1],
			["leaf", 2],
			["telemetry", 0],
		]);
		expect(hierarchy[0]?.childCount).toBe(1);
		expect(hierarchy[1]?.childCount).toBe(1);
		expect(hierarchy[1]?.dependencies).toEqual(["telemetry"]);
	});

	it("visits every task once when malformed containment contains a cycle", () => {
		const graph: TaskGraph = {
			nodes: [
				node("a", "A", { parentIds: ["b"], childIds: ["b"] }),
				node("b", "B", { parentIds: ["a"], childIds: ["a"] }),
			],
			rootIds: [],
		};

		const hierarchy = buildTaskHierarchy(graph);

		expect(hierarchy.map(({ task }) => task.id).sort()).toEqual(["a", "b"]);
	});
});
