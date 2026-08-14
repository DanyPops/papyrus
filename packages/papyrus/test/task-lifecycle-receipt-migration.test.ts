import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLITE_SCHEMA_VERSION } from "../src/constants.ts";
import { migrateDb, openDb } from "../src/db.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

describe("task-lifecycle-mutation-receipts migration", () => {
	it("adds durable pending/completed receipt storage to a v26 database", () => {
		const path = join(tempDir("papyrus-task-lifecycle-receipts-"), "papyrus.db");
		let db = openDb(path);
		db.exec("DROP TABLE task_mutation_requests; PRAGMA user_version = 26;");
		db.close();

		db = openDb(path);
		expect(migrateDb(db)).toEqual({
			from: 26,
			to: SQLITE_SCHEMA_VERSION,
			applied: ["task-lifecycle-mutation-receipts", "artifact-multi-project-scope", "artifact-scope-tri-state-and-scope-groups"],
		});
		expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_mutation_requests'").get()).not.toBeNull();
		expect(
			db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'task_mutation_requests_expiry_idx'").get(),
		).not.toBeNull();
		expect(
			db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'task_mutation_requests_pending_task_operation_idx'").get(),
		).not.toBeNull();
		db.close();
	});
});
