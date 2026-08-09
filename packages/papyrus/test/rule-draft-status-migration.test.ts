import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLITE_SCHEMA_VERSION } from "../src/constants.ts";
import { migrateDb, openDb } from "../src/db.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

describe("rule-draft-status migration", () => {
	it("adds draft to an existing rule lifecycle without changing existing Rule rows", () => {
		const path = join(tempDir("papyrus-rule-draft-status-migration-"), "papyrus.db");
		const legacy = openDb(path);
		legacy.prepare("DELETE FROM statuses WHERE kind = 'rule' AND name = 'draft'").run();
		legacy.exec(`
			INSERT INTO artifacts (id, kind, title, status, created_at, updated_at) VALUES
				('active-rule', 'rule', 'Active rule', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
				('deprecated-rule', 'rule', 'Deprecated rule', 'deprecated', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
			PRAGMA user_version = 24;
		`);
		legacy.close();

		const db = openDb(path);
		const result = migrateDb(db);
		expect(result).toEqual({ from: 24, to: SQLITE_SCHEMA_VERSION, applied: ["rule-draft-status"] });
		expect(
			(db.prepare("SELECT name FROM statuses WHERE kind = 'rule' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name),
		).toEqual(["active", "deprecated", "draft"]);
		expect(db.prepare("SELECT id, status FROM artifacts WHERE kind = 'rule' ORDER BY id").all()).toEqual([
			{ id: "active-rule", status: "active" },
			{ id: "deprecated-rule", status: "deprecated" },
		]);
		db.close();
	});
});
