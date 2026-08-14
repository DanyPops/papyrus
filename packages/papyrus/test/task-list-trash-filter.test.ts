import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import type { GateRunner } from "../src/gate/gate-runner.ts";
import { Tasks } from "../src/task/task-service.ts";
import { SQLiteTaskEventStore } from "../src/task-event/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/task-focus/sqlite-task-focus-store.ts";
import { SQLiteTaskScopeStore } from "../src/task-scope/sqlite-task-scope-store.ts";

const gates: GateRunner = { run: () => [], runAsync: async () => [] };
const PROJECT = "/work/papyrus";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const tasks = new Tasks(artifacts, gates, new SQLiteTaskFocusStore(db), new SQLiteTaskEventStore(db), new SQLiteTaskScopeStore(db));
	return { db, artifacts, tasks };
}

/**
 * Regression: tasks.list's scoped branch (project/graph mode) fetched candidates by id via
 * artifacts.get(), which is deliberately trash-transparent for show/restore -- but a trashed
 * task's id stays in task_scopes until the retention window actually purges it, so it kept
 * leaking back into list results for the entire trash grace period. The "all" scope branch
 * never had this bug (it already goes through query(), which excludes trash by default).
 */
describe("tasks.list excludes a trashed task, in every scope mode, matching query()'s own default", () => {
	it("project scope: a trashed task disappears from tasks.list immediately, not just after the purge window", () => {
		const { artifacts, tasks } = fixture();
		const keep = tasks.create({ title: "Keep", projectRoot: PROJECT, projectSource: "cwd" });
		const trashed = tasks.create({ title: "Trash me", projectRoot: PROJECT, projectSource: "cwd" });

		expect(
			tasks
				.list({ projectRoot: PROJECT })
				.map((task) => task.id)
				.sort(),
		).toEqual([keep.id, trashed.id].sort());

		artifacts.trash(trashed.id);

		expect(tasks.list({ projectRoot: PROJECT }).map((task) => task.id)).toEqual([keep.id]);
	});

	it("graph scope: a trashed descendant disappears from tasks.list the same way", () => {
		const { artifacts, tasks } = fixture();
		const epic = tasks.create({ title: "Epic", projectRoot: PROJECT, projectSource: "cwd" });
		const child = tasks.create({ title: "Child", parentId: epic.id, projectRoot: PROJECT, projectSource: "cwd" });
		tasks.setView(PROJECT, "graph", epic.id);

		expect(
			tasks
				.list({ projectRoot: PROJECT })
				.map((task) => task.id)
				.sort(),
		).toEqual([epic.id, child.id].sort());

		artifacts.trash(child.id);

		expect(tasks.list({ projectRoot: PROJECT }).map((task) => task.id)).toEqual([epic.id]);
	});

	it("all scope already excluded trash correctly before this fix -- confirms the fix doesn't change that path", () => {
		const { artifacts, tasks } = fixture();
		const keep = tasks.create({ title: "Keep everywhere" });
		const trashed = tasks.create({ title: "Trash everywhere" });
		artifacts.trash(trashed.id);
		expect(tasks.list({}).map((task) => task.id)).toEqual([keep.id]);
	});
});
