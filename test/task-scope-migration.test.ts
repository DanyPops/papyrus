import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { migrateDb, openDb } from "../src/db.ts";

describe("task project scope migration", () => {
	it("keeps existing tasks explicitly unscoped instead of guessing a project", () => {
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-scope-")), "papyrus.db");
		let db = openDb(path);
		new SQLiteArtifactStore(db).create({ kind: "task", title: "Existing" });
		db.exec(`
			DROP TABLE task_views;
			DROP TABLE task_scopes;
			ALTER TABLE task_focus RENAME TO task_focus_v5;
			CREATE TABLE task_focus (scope TEXT PRIMARY KEY CHECK (scope = 'global'), task_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id), updated_at TEXT NOT NULL);
			INSERT INTO task_focus (scope, task_id, updated_at) SELECT scope, task_id, updated_at FROM task_focus_v5;
			DROP TABLE task_focus_v5;
			PRAGMA user_version = 3;
		`);
		db.close();

		db = openDb(path);
		expect(migrateDb(db)).toEqual({ from: 3, to: 5, applied: ["task-project-scope", "task-focus-continuation"] });
		expect(db.prepare("SELECT project_root, source FROM task_scopes").get()).toEqual({ project_root: null, source: "unscoped" });
		expect(db.prepare("SELECT COUNT(*) AS count FROM task_views").get()).toEqual({ count: 0 });
		db.close();
	});
});
