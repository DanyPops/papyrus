import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { SQLiteTaskEventStore } from "../src/adapters/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { SQLiteTaskScopeStore } from "../src/adapters/sqlite-task-scope-store.ts";
import { openDb } from "../src/db.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { tasksOperations } from "../src/modules/tasks.ts";
import { EXPECTED_OPERATION_NAMES } from "../src/service.ts";
import { Tasks } from "../src/task-service.ts";

const PROJECT_ROOT = "/workspace/papyrus";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const gates = new SQLiteGateRunner(db);
	const tasks = new Tasks(artifacts, gates, new SQLiteTaskFocusStore(db), new SQLiteTaskEventStore(db), new SQLiteTaskScopeStore(db));
	const registry = new OperationRegistry();
	registry.registerAll(tasksOperations(tasks, artifacts));
	return { registry, tasks };
}

describe("modules/tasks — the second Papyrus-native registered module", () => {
	it("registers exactly the tasks.* operations EXPECTED_OPERATION_NAMES declares, no more, no fewer", () => {
		const { registry } = fixture();
		const expectedTaskOps = EXPECTED_OPERATION_NAMES.filter((name) => name.startsWith("tasks."));
		expect(registry.list()).toEqual([...expectedTaskOps].sort());
	});

	it("each registered operation is owned by the tasks module", () => {
		const { registry } = fixture();
		for (const name of registry.list()) {
			expect(registry.get(name)?.moduleId).toBe("tasks");
		}
	});

	it("delegates create/list/show/lifecycle operations to the real Tasks instance with the same field mapping as the prior inline handlers", async () => {
		const { registry } = fixture();
		const created = await registry.get("tasks.create")!.execute({ title: "First task", project_root: PROJECT_ROOT }) as { id: string; status: string };
		expect(created.status).toBe("todo");

		const listed = await registry.get("tasks.list")!.execute({ project_root: PROJECT_ROOT }) as Array<{ id: string }>;
		expect(listed.map((t) => t.id)).toContain(created.id);

		const shown = await registry.get("tasks.show")!.execute({ id: created.id }) as { id: string };
		expect(shown.id).toBe(created.id);

		const started = await registry.get("tasks.start")!.execute({ id: created.id }) as { status: string };
		expect(started.status).toBe("in-progress");

		const focused = await registry.get("tasks.focused")!.execute({ project_root: PROJECT_ROOT }) as { artifact: { id: string } } | null;
		expect(focused?.artifact.id).toBe(created.id);
	});

	it("tasks.context assembles from the same shared ArtifactStore port the composition root passes in, not a Tasks-internal copy", async () => {
		const { registry } = fixture();
		await registry.get("tasks.create")!.execute({ title: "Context task", project_root: PROJECT_ROOT });
		const summary = await registry.get("tasks.context")!.execute({ project_root: PROJECT_ROOT }) as string | null;
		expect(summary).toContain("Context task");
	});

	it("dependency and containment operations still enforce Task-domain invariants unchanged", async () => {
		const { registry } = fixture();
		const a = await registry.get("tasks.create")!.execute({ title: "A", project_root: PROJECT_ROOT }) as { id: string };
		const b = await registry.get("tasks.create")!.execute({ title: "B", project_root: PROJECT_ROOT }) as { id: string };
		await registry.get("tasks.depend")!.execute({ id: a.id, dependency_id: b.id });
		const graph = await registry.get("tasks.graph")!.execute({ project_root: PROJECT_ROOT }) as { nodes: Array<{ task: { id: string }; dependencyIds: string[] }> };
		expect(graph.nodes.find((n) => n.task.id === a.id)?.dependencyIds).toEqual([b.id]);

		await registry.get("tasks.undepend")!.execute({ id: a.id, dependency_id: b.id });
		const graphAfter = await registry.get("tasks.graph")!.execute({ project_root: PROJECT_ROOT }) as { nodes: Array<{ task: { id: string }; dependencyIds: string[] }> };
		expect(graphAfter.nodes.find((n) => n.task.id === a.id)?.dependencyIds).toEqual([]);
	});

	it("rejects a request missing a required field, matching the prior inline handler's validation", () => {
		const { registry } = fixture();
		expect(() => registry.get("tasks.create")!.execute({ project_root: PROJECT_ROOT })).toThrow("title is required");
	});
});
