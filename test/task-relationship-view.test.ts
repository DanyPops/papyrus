import { describe, expect, it } from "bun:test";
import type { Artifact } from "../src/domain/artifact.ts";
import { projectTaskRelationships } from "../src/task-relationship-view.ts";
import type { TaskGraph } from "../src/task-service.ts";

function task(id: string, title: string): Artifact {
	return {
		id, kind: "task", title, status: "pending", subtype: "", body: "", labels: [], extra: {},
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
	};
}

const selected: Artifact = {
	...task("epic", "Token router"),
	edges: [
		{ from: "epic", relation: "contains", to: "adapter" },
		{ from: "adapter", relation: "part_of", to: "epic" },
		{ from: "adapter", relation: "depends_on", to: "research" },
		{ from: "research", relation: "references", to: "contracts" },
	],
};

const graph: TaskGraph = {
	nodes: [
		{ task: task("epic", "Token router"), parentIds: [], childIds: ["adapter"], dependencyIds: [] },
		{ task: task("adapter", "Codex telemetry adapter"), parentIds: ["epic"], childIds: [], dependencyIds: ["research"] },
		{ task: task("research", "Provider research"), parentIds: [], childIds: [], dependencyIds: [] },
	],
	rootIds: ["epic", "research"],
};

describe("task relationship graph projection", () => {
	it("deduplicates composition, reverses dependencies, and resolves task titles", () => {
		const display = projectTaskRelationships(selected, graph);

		expect(display.nodes).toEqual([
			{ id: "epic", label: "Token router", status: "pending" },
			{ id: "adapter", label: "Codex telemetry adapter", status: "pending" },
			{ id: "research", label: "Provider research", status: "pending" },
			{ id: "contracts", label: "contracts" },
		]);
		expect(display.edges).toEqual([
			{ from: "epic", to: "adapter" },
			{ from: "research", to: "adapter", label: "unlocks" },
			{ from: "research", to: "contracts", label: "references" },
		]);
	});
});
