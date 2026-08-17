import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { migrateDb, openDb } from "../src/db.ts";
import { getArtifact } from "../src/ops.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

describe("artifact-aliases migration: every existing row is backfilled with a real, unique alias", () => {
	it("derives an alias from title for a pre-migration row, and dedupes two rows sharing a title", () => {
		const path = join(tempDir("papyrus-alias-migration-"), "papyrus.db");
		let db = openDb(path); // bootstraps at the full current schema, including artifacts.alias
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO artifacts (id, kind, title, status, subtype, body, labels, extra, created_at, updated_at)
			VALUES ('task-a', 'task', 'Fix the timeout bug', 'todo', '', '', '[]', '{}', ?, ?)
		`).run(now, now);
		db.prepare(`
			INSERT INTO artifacts (id, kind, title, status, subtype, body, labels, extra, created_at, updated_at)
			VALUES ('task-b', 'task', 'Fix the timeout bug', 'todo', '', '', '[]', '{}', ?, ?)
		`).run(now, now);
		// Simulate a pre-migration database: drop the column (and its unique index, which must go
		// first -- SQLite's DROP COLUMN silently fails to actually remove an indexed column
		// otherwise) this migration itself adds.
		db.exec(`
			DROP INDEX IF EXISTS artifacts_alias_idx;
			ALTER TABLE artifacts DROP COLUMN alias;
			PRAGMA user_version = 23;
		`);
		db.close();

		db = openDb(path);
		expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(23);
		const result = migrateDb(db);
		expect(result.from).toBe(23);
		expect(result.applied).toEqual([
			"artifact-aliases",
			"rule-draft-status",
			"task-projects-and-create-idempotency",
			"task-lifecycle-mutation-receipts",
			"artifact-multi-project-scope",
			"artifact-scope-tri-state-and-scope-groups",
			"discuss-quiz",
		]);

		const a = getArtifact(db, "task-a")!;
		const b = getArtifact(db, "task-b")!;
		expect(a.alias).toBe("fix-the-timeout-bug");
		expect(b.alias).toBe("fix-the-timeout-bug-2");
		db.close();
	});

	it("is a no-op once already migrated -- reopening an up-to-date database changes nothing", () => {
		const path = join(tempDir("papyrus-alias-migration-noop-"), "papyrus.db");
		let db = openDb(path);
		const artifactId = "task-c";
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO artifacts (id, kind, title, status, subtype, body, labels, extra, created_at, updated_at, alias)
			VALUES (?, 'task', 'Already aliased', 'todo', '', '', '[]', '{}', ?, ?, 'already-aliased')
		`).run(artifactId, now, now);
		db.close();

		db = openDb(path);
		const before = getArtifact(db, artifactId)!.alias;
		expect(before).toBe("already-aliased");
		db.close();
	});
});
