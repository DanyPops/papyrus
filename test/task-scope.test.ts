import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskEventStore } from "../src/adapters/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { SQLiteTaskScopeStore } from "../src/adapters/sqlite-task-scope-store.ts";
import { openDb } from "../src/db.ts";
import type { GateRunner } from "../src/ports/gate-runner.ts";
import { Tasks } from "../src/task-service.ts";

const gates: GateRunner = { run: () => [], runAsync: async () => [] };
const PAPYRUS = "/work/papyrus";
const JITTOR = "/work/jittor";

function fixture() {
	const db = openDb(":memory:");
	const tasks = new Tasks(
		new SQLiteArtifactStore(db),
		gates,
		new SQLiteTaskFocusStore(db),
		new SQLiteTaskEventStore(db),
		new SQLiteTaskScopeStore(db),
	);
	return { db, tasks };
}

describe("task project and focused-graph scope", () => {
	it("defaults each cwd to its project and persists a focused root view", () => {
		const { tasks } = fixture();
		const epic = tasks.create({ title: "Papyrus epic", projectRoot: PAPYRUS, projectSource: "cwd" });
		const child = tasks.create({ title: "Papyrus child", parentId: epic.id, projectRoot: PAPYRUS, projectSource: "cwd" });
		tasks.create({ title: "Other Papyrus root", projectRoot: PAPYRUS, projectSource: "cwd" });
		tasks.create({ title: "Jittor", projectRoot: JITTOR, projectSource: "cwd" });

		const project = tasks.graph({ projectRoot: PAPYRUS });
		expect(project.nodes).toHaveLength(3);
		expect(project.scope).toMatchObject({ mode: "project", label: "papyrus", projectRoot: PAPYRUS });

		expect(tasks.setView(PAPYRUS, "graph", epic.id)).toMatchObject({ mode: "graph", rootTaskId: epic.id });
		const focused = tasks.graph({ projectRoot: PAPYRUS });
		expect(focused.nodes.map((node) => node.task.id).sort()).toEqual([epic.id, child.id].sort());
		expect(focused.scope?.label).toBe("papyrus · Papyrus epic");
	});

	it("does not leak active focus from another project into the current view", () => {
		const { tasks } = fixture();
		const papyrus = tasks.create({ title: "Papyrus", projectRoot: PAPYRUS, projectSource: "cwd" });
		const jittor = tasks.create({ title: "Jittor", projectRoot: JITTOR, projectSource: "cwd" });
		tasks.focus(jittor.id);
		expect(tasks.active({ projectRoot: PAPYRUS })).toBeNull();
		expect(tasks.active({ projectRoot: JITTOR })?.id).toBe(jittor.id);
		expect(tasks.graph({ projectRoot: PAPYRUS }).nodes.map((node) => node.task.id)).toEqual([papyrus.id]);
	});

	it("provides an explicit persisted all-projects view", () => {
		const { tasks } = fixture();
		tasks.create({ title: "Papyrus", projectRoot: PAPYRUS, projectSource: "cwd" });
		tasks.create({ title: "Jittor", projectRoot: JITTOR, projectSource: "cwd" });
		tasks.setView(PAPYRUS, "all");
		const graph = tasks.graph({ projectRoot: PAPYRUS });
		expect(graph.nodes).toHaveLength(2);
		expect(graph.scope).toEqual({ mode: "all", label: "All projects", projectRoot: PAPYRUS });
	});

	it("keeps migrated tasks unscoped until an explicit assignment", () => {
		const { tasks } = fixture();
		const task = tasks.create({ title: "Unknown owner" });
		expect(tasks.graph({ projectRoot: PAPYRUS }).nodes).toHaveLength(0);
		expect(tasks.graph({ projectRoot: PAPYRUS, scope: "all" }).nodes).toHaveLength(1);
		tasks.assignProject(task.id, PAPYRUS, { actor: "user", source: "cli" });
		expect(tasks.graph({ projectRoot: PAPYRUS, scope: "project" }).nodes[0]?.task.id).toBe(task.id);
		expect(tasks.history(task.id).events[0]).toMatchObject({ type: "project_assigned", actor: "user" });
	});
});
