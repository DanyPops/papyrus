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
 *
 * Today's SEED_SQL (a fresh v23+ bootstrap) no longer seeds kind=skill at all, so this fixture
 * inserts it explicitly first -- simulating what a real v21 database's schema actually had,
 * before the kind was retired at v23.
 */
function skillDatabaseAtV21(path: string): void {
	const db = openDb(path); // bootstraps at the full current schema
	db.exec(`
		INSERT OR IGNORE INTO kinds VALUES ('skill', 'legacy, pre-retirement');
		INSERT OR IGNORE INTO statuses VALUES ('active', 'skill');
		INSERT OR IGNORE INTO statuses VALUES ('deprecated', 'skill');
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
});

describe("retire-skill-kind (v23)", () => {
	it("drops the 'skill' kind/statuses rows once no data or code depends on them anymore", () => {
		const path = join(tempDir("papyrus-skill-kind-retirement-"), "papyrus.db");
		skillDatabaseAtV21(path);

		const db = openDb(path);
		const result = migrateDb(db);
		expect(result.applied).toContain("retire-skill-kind");

		expect(db.prepare("SELECT name FROM kinds WHERE name = 'skill'").get()).toBeNull();
		expect(db.prepare("SELECT name FROM statuses WHERE kind = 'skill'").get()).toBeNull();

		// The write path is genuinely gone: a fresh kind=skill insert now fails the FK constraint.
		expect(() => db.prepare(
			"INSERT INTO artifacts (id, kind, subtype, title, status, created_at, updated_at) VALUES ('should-fail', 'skill', 'workflow', 'x', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
		).run()).toThrow();
		db.close();
	});
});
