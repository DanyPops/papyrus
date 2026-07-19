import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskEventStore } from "../src/adapters/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { migrateDb, openDb } from "../src/db.ts";
import type { GateRunner } from "../src/ports/gate-runner.ts";
import { Tasks } from "../src/task-service.ts";

const passingGates: GateRunner = {
	run: () => [],
	runAsync: async () => [],
};

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const events = new SQLiteTaskEventStore(db);
	const tasks = new Tasks(artifacts, passingGates, new SQLiteTaskFocusStore(db), events);
	return { db, artifacts, events, tasks };
}

describe("append-only task lifecycle history", () => {
	it("records creation, transitions, completion attempts, actors, and evidence in order", () => {
		const { db, tasks } = fixture();
		const task = tasks.create({ title: "History" }, { actor: "agent", source: "test" });
		tasks.transition(task.id, "start", { actor: "agent", source: "test", reason: "begin" });
		tasks.transition(task.id, "submit", { actor: "agent", source: "test" });
		expect(tasks.complete(task.id, { actor: "reviewer", source: "test" }).completed).toBe(true);

		const page = tasks.history(task.id, { direction: "asc", limit: 10 });
		expect(page.events.map((event) => event.type)).toEqual(["created", "started", "submitted", "completion_attempted", "completed"]);
		expect(page.events[1]?.reason).toBe("begin");
		expect(page.events.at(-1)?.actor).toBe("reviewer");
		expect(page.events.at(-1)?.evidence?.result).toBe("completed");
		expect(() => db.prepare("UPDATE task_events SET actor = 'tampered'").run()).toThrow("task_events are append-only");
		expect(() => db.prepare("DELETE FROM task_events").run()).toThrow("task_events are append-only");
	});

	it("records failed review, retry, and standalone gate evaluation", async () => {
		const db = openDb(":memory:");
		const artifacts = new SQLiteArtifactStore(db);
		const events = new SQLiteTaskEventStore(db);
		const failing: GateRunner = {
			run: () => [{ gate: { type: "command", target: "false" }, passed: false, output: "failed" }],
			runAsync: async () => [{ gate: { type: "command", target: "false" }, passed: false, output: "failed" }],
		};
		const tasks = new Tasks(artifacts, failing, new SQLiteTaskFocusStore(db), events);
		const task = tasks.create({ title: "Failure" });
		tasks.transition(task.id, "start");
		tasks.transition(task.id, "submit");
		expect(tasks.complete(task.id).completed).toBe(false);
		tasks.transition(task.id, "retry", { actor: "agent", source: "test", reason: "repair" });
		await tasks.runGates(task.id);
		const history = tasks.history(task.id, { direction: "asc", limit: 10 }).events;
		expect(history.map((event) => event.type)).toEqual([
			"created", "started", "submitted", "completion_attempted", "review_rejected", "retried", "gates_evaluated",
		]);
		expect(history.find((event) => event.type === "review_rejected")?.evidence?.result).toBe("rejected");
		expect(history.find((event) => event.type === "gates_evaluated")?.evidence?.result).toBe("failed");
	});

	it("paginates with explicit bounds and rolls task creation back when event validation fails", () => {
		const { artifacts, tasks } = fixture();
		expect(() => tasks.create({ title: "Rollback" }, { actor: "x".repeat(129), source: "test" })).toThrow("actor must be between");
		expect(artifacts.query({ kind: "task" })).toHaveLength(0);
		const task = tasks.create({ title: "Paged" });
		tasks.transition(task.id, "start");
		const first = tasks.history(task.id, { limit: 1 });
		expect(first.events).toHaveLength(1);
		expect(first.nextCursor).toBeDefined();
		expect(tasks.history(task.id, { limit: 1, cursor: first.nextCursor }).events).toHaveLength(1);
		expect(() => tasks.history(task.id, { limit: 101 })).toThrow("between 1 and 100");
	});

	it("migrates v2 explicitly without fabricating history for existing tasks", () => {
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-history-")), "papyrus.db");
		let db = openDb(path);
		const artifacts = new SQLiteArtifactStore(db);
		artifacts.create({ kind: "task", title: "Before history" });
		db.exec(`
			DROP TABLE task_views;
			DROP TABLE task_scopes;
			DROP TRIGGER task_events_no_update;
			DROP TRIGGER task_events_no_delete;
			DROP TABLE task_events;
			ALTER TABLE task_focus RENAME TO task_focus_v5;
			CREATE TABLE task_focus (scope TEXT PRIMARY KEY CHECK (scope = 'global'), task_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id), updated_at TEXT NOT NULL);
			INSERT INTO task_focus (scope, task_id, updated_at) SELECT scope, task_id, updated_at FROM task_focus_v5;
			DROP TABLE task_focus_v5;
			PRAGMA user_version = 2;
		`);
		db.close();

		db = openDb(path);
		expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
		expect(migrateDb(db)).toEqual({ from: 2, to: 5, applied: ["task-history", "task-project-scope", "task-focus-continuation"] });
		expect((db.prepare("SELECT COUNT(*) AS count FROM task_events").get() as { count: number }).count).toBe(0);
		db.close();
	});
});
