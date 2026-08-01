import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { migrateDb, openDb } from "../src/db.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

/** Discussions moved from kind doc to task (see domain/discussion.ts); already-persisted rows need the same remap newly-created ones get for free. */
function legacyDiscussionDatabase(path: string): void {
	const db = openDb(path); // bootstraps at the full current schema, including kind "doc" support
	db.exec(`
		INSERT INTO artifacts (id, kind, subtype, title, status, created_at, updated_at) VALUES
			('active-discussion', 'doc', 'discussion', 'Still deciding', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
			('settled-discussion', 'doc', 'discussion', 'Already resolved', 'archived', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
			('real-doc', 'doc', '', 'A real document', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
	`);
	db.exec("PRAGMA user_version = 16");
	db.close();
}

describe("discussion-task-kind migration", () => {
	it("reclassifies every Discussion row to kind task, remapping status, and leaves real docs untouched", () => {
		const path = join(tempDir("papyrus-discuss-kind-migration-"), "papyrus.db");
		legacyDiscussionDatabase(path);

		const db = openDb(path);
		const result = migrateDb(db);
		expect(result.from).toBe(16);
		expect(result.applied).toContain("discussion-task-kind");

		const rows = db.prepare("SELECT id, kind, status FROM artifacts ORDER BY id").all() as Array<{
			id: string;
			kind: string;
			status: string;
		}>;
		expect(rows).toEqual([
			{ id: "active-discussion", kind: "task", status: "in-progress" },
			{ id: "real-doc", kind: "doc", status: "active" },
			{ id: "settled-discussion", kind: "task", status: "done" },
		]);
		db.close();
	});
});
