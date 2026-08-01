import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { migrateDb, openDb } from "../src/db.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);

/**
 * Migration 22, part of the Skill->Playbook consolidation. Everything migration 18 (playbook-kind)
 * left behind under kind=skill (workflow and artifact-template rows) moves to kind=playbook too,
 * preserving subtype and status. Fixture starts at v21 (right before this migration exists) so
 * only this one migration's effect is under test, rather than compounding with v18's.
 */
function skillDatabaseAtV21(path: string): void {
	const db = openDb(path); // bootstraps at the full current schema, including kind "skill" support
	db.exec(`
		INSERT INTO artifacts (id, kind, subtype, title, status, created_at, updated_at) VALUES
			('live-verify-leaf', 'skill', 'workflow', 'live-verify-leaf', 'deprecated', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
			('a-template', 'skill', 'artifact-template', 'Bug report template', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
	`);
	db.exec("PRAGMA user_version = 21");
	db.close();
}

describe("skill-to-playbook-data-migration (v22)", () => {
	it("moves every remaining kind=skill row to kind=playbook, preserving subtype and status", () => {
		const path = join(tempDir("papyrus-skill-kind-retirement-"), "papyrus.db");
		skillDatabaseAtV21(path);

		const db = openDb(path);
		const result = migrateDb(db);
		expect(result.from).toBe(21);
		expect(result.applied).toContain("skill-to-playbook-data-migration");

		const rows = db.prepare("SELECT id, kind, subtype, status FROM artifacts ORDER BY id").all() as Array<{ id: string; kind: string; subtype: string | null; status: string }>;
		expect(rows).toEqual([
			{ id: "a-template", kind: "playbook", subtype: "artifact-template", status: "active" },
			{ id: "live-verify-leaf", kind: "playbook", subtype: "workflow", status: "deprecated" },
		]);

		// No kind=skill artifacts survive the migration.
		const remainingSkillRows = db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'skill'").get() as { n: number };
		expect(remainingSkillRows.n).toBe(0);
		db.close();
	});

	it("deliberately leaves the 'skill' kind/statuses type rows in place -- src/modules/skills.ts still writes kind=skill until its own retirement task lands", () => {
		const path = join(tempDir("papyrus-skill-kind-retirement-"), "papyrus.db");
		skillDatabaseAtV21(path);

		const db = openDb(path);
		migrateDb(db);

		const kinds = (db.prepare("SELECT name FROM kinds WHERE name = 'skill'").all() as Array<{ name: string }>).map((row) => row.name);
		expect(kinds).toEqual(["skill"]);
		const statuses = (db.prepare("SELECT name FROM statuses WHERE kind = 'skill' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
		expect(statuses).toEqual(["active", "deprecated"]);

		// The write path is still live: a fresh kind=skill insert must still succeed (FK intact).
		db.prepare("INSERT INTO artifacts (id, kind, subtype, title, status, created_at, updated_at) VALUES ('still-writable', 'skill', 'workflow', 'x', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
		const row = db.prepare("SELECT kind FROM artifacts WHERE id = 'still-writable'").get() as { kind: string };
		expect(row.kind).toBe("skill");
		db.close();
	});
});
