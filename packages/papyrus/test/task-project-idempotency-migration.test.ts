import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLITE_SCHEMA_VERSION } from "../src/constants.ts";
import { migrateDb, openDb } from "../src/db.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

describe("task-projects-and-create-idempotency migration", () => {
	it("backfills registered projects from existing task scopes and adds durable request storage", () => {
		const path = join(tempDir("papyrus-task-project-idempotency-migration-"), "papyrus.db");
		let db = openDb(path);
		db.exec(`
			INSERT INTO artifacts (id, kind, title, status, created_at, updated_at)
			VALUES ('task-1', 'task', 'Existing task', 'todo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
			INSERT INTO task_scopes (task_id, project_root, source, assigned_at)
			VALUES ('task-1', '/tmp/projects/Papyrus', 'explicit', '2026-01-01T00:00:00.000Z');
			DROP TABLE task_mutation_requests;
			DROP TABLE task_create_requests;
			DROP TABLE task_projects;
			PRAGMA user_version = 25;
		`);
		db.close();

		db = openDb(path);
		expect(migrateDb(db)).toEqual({
			from: 25,
			to: SQLITE_SCHEMA_VERSION,
			applied: [
				"task-projects-and-create-idempotency",
				"task-lifecycle-mutation-receipts",
				"artifact-multi-project-scope",
				"artifact-scope-tri-state-and-scope-groups",
				"discuss-quiz",
				"binder-hierarchy-and-label-inheritance",
			],
		});
		expect(db.prepare("SELECT name, aliases_json, project_root FROM task_projects").all()).toEqual([
			{ name: "Papyrus", aliases_json: "[]", project_root: "/tmp/projects/Papyrus" },
		]);
		expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_create_requests'").get()).not.toBeNull();
		db.close();
	});
});
