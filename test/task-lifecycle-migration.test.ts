import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { migrateDb, openDb } from "../src/db.ts";
import { Tasks } from "../src/task-service.ts";

function legacyDatabase(path: string): void {
	const db = new Database(path, { create: true });
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE kinds (name TEXT PRIMARY KEY, description TEXT);
		CREATE TABLE statuses (name TEXT NOT NULL, kind TEXT NOT NULL REFERENCES kinds(name), PRIMARY KEY (name, kind));
		CREATE TABLE relation_names (name TEXT PRIMARY KEY, description TEXT);
		CREATE TABLE artifacts (
			id TEXT PRIMARY KEY, kind TEXT NOT NULL REFERENCES kinds(name), title TEXT NOT NULL,
			status TEXT NOT NULL, subtype TEXT DEFAULT '', body TEXT DEFAULT '', labels TEXT DEFAULT '[]',
			extra TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			FOREIGN KEY (kind, status) REFERENCES statuses(kind, name)
		);
		CREATE TABLE edges (
			from_id TEXT NOT NULL REFERENCES artifacts(id), relation TEXT NOT NULL REFERENCES relation_names(name),
			to_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY (from_id, relation, to_id)
		);
		INSERT INTO kinds VALUES ('task', 'legacy tasks');
		INSERT INTO statuses VALUES ('pending', 'task'), ('active', 'task'), ('done', 'task'), ('failed', 'task');
		INSERT INTO relation_names VALUES ('depends_on', 'legacy dependency');
		INSERT INTO artifacts (id, kind, title, status, created_at, updated_at) VALUES
			('todo-task', 'task', 'Todo', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
			('older-active', 'task', 'Older active', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'),
			('newer-active', 'task', 'Newer active', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T02:00:00.000Z'),
			('rejected-task', 'task', 'Rejected', 'failed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
			('done-task', 'task', 'Done', 'done', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
		PRAGMA user_version = 1;
	`);
	db.close();
}

describe("task lifecycle schema migration", () => {
	it("migrates lifecycle statuses and preserves one deterministic active focus", () => {
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-lifecycle-")), "papyrus.db");
		legacyDatabase(path);

		const db = openDb(path);
		expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_focus'").get()).toBeNull();

		expect(migrateDb(db)).toEqual({ from: 1, to: 5, applied: ["task-lifecycle-and-focus", "task-history", "task-project-scope", "task-focus-continuation"] });
		const rows = db.prepare("SELECT id, status FROM artifacts ORDER BY id").all() as Array<{ id: string; status: string }>;
		expect(rows).toEqual([
			{ id: "done-task", status: "done" },
			{ id: "newer-active", status: "in-progress" },
			{ id: "older-active", status: "in-progress" },
			{ id: "rejected-task", status: "rejected" },
			{ id: "todo-task", status: "todo" },
		]);
		expect(db.prepare("SELECT task_id, status, pause_reason FROM task_focus WHERE scope = 'global'").get()).toEqual({ task_id: "newer-active", status: "active", pause_reason: null });
		expect((db.prepare("SELECT name FROM statuses WHERE kind = 'task' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
			"canceled", "done", "in-progress", "rejected", "review", "todo",
		]);
		expect((db.prepare("SELECT COUNT(*) AS count FROM task_events").get() as { count: number }).count).toBe(0);
		expect((db.prepare("SELECT COUNT(*) AS count FROM task_scopes WHERE project_root IS NULL AND source = 'unscoped'").get() as { count: number }).count).toBe(5);
		expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
		expect(db.prepare("SELECT name FROM statuses WHERE kind = 'task' ORDER BY rowid LIMIT 1").get()).toEqual({ name: "done" });
		const created = new Tasks(new SQLiteArtifactStore(db), new SQLiteGateRunner(db)).create({ title: "Created after migration" });
		expect(created.status).toBe("todo");
		db.close();
	});

	it("uses todo as the default for new task databases", () => {
		const db = openDb(":memory:");
		expect(db.prepare("SELECT name FROM statuses WHERE kind = 'task' ORDER BY rowid LIMIT 1").get()).toEqual({ name: "todo" });
		db.close();
	});
});
