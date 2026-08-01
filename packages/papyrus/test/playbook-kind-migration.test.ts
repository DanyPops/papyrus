import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { migrateDb, openDb } from "../src/db.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

/**
 * Legacy trigger/steps/tools skills (subtype-less) move to their own "playbook" kind at v18;
 * artifact-template and workflow skills stay put at that version -- but migrateDb always runs to
 * the current schema, so v22's skill-to-playbook-data-migration moves everything else left under
 * kind=skill too, and v23 drops the (by then unused) 'skill' kind/statuses rows entirely. See
 * skill-kind-retirement-migration.test.ts for those two migrations in isolation.
 *
 * Today's SEED_SQL (a fresh v23+ bootstrap) no longer seeds kind=skill at all, so this fixture
 * inserts it explicitly first -- simulating what a real v17 database's schema actually had,
 * before the kind was retired.
 */
function legacySkillDatabase(path: string): void {
	const db = openDb(path); // bootstraps at the full current schema
	db.exec(`
		INSERT OR IGNORE INTO kinds VALUES ('skill', 'legacy, pre-retirement');
		INSERT OR IGNORE INTO statuses VALUES ('active', 'skill');
		INSERT OR IGNORE INTO statuses VALUES ('deprecated', 'skill');
		INSERT INTO artifacts (id, kind, subtype, title, status, created_at, updated_at) VALUES
			('legacy-playbook', 'skill', '', 'TDD workflow', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
			('null-subtype-playbook', 'skill', NULL, 'Diagnose a bug', 'deprecated', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
			('a-template', 'skill', 'artifact-template', 'Bug report template', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
			('a-workflow', 'skill', 'workflow', 'Ship a feature', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
	`);
	db.exec("PRAGMA user_version = 17");
	db.close();
}

describe("playbook-kind migration", () => {
	it("moves only subtype-less Skill rows to kind playbook, leaving artifact-template and workflow rows as Skills", () => {
		const path = join(tempDir("papyrus-playbook-kind-migration-"), "papyrus.db");
		legacySkillDatabase(path);

		const db = openDb(path);
		const result = migrateDb(db);
		expect(result.from).toBe(17);
		expect(result.applied).toContain("playbook-kind");

		expect(result.applied).toContain("skill-to-playbook-data-migration");
		expect(result.applied).toContain("retire-skill-kind");

		const rows = db.prepare("SELECT id, kind, subtype, status FROM artifacts ORDER BY id").all() as Array<{
			id: string;
			kind: string;
			subtype: string | null;
			status: string;
		}>;
		expect(rows).toEqual([
			{ id: "a-template", kind: "playbook", subtype: "artifact-template", status: "active" },
			{ id: "a-workflow", kind: "playbook", subtype: "workflow", status: "active" },
			{ id: "legacy-playbook", kind: "playbook", subtype: "", status: "active" },
			{ id: "null-subtype-playbook", kind: "playbook", subtype: null, status: "deprecated" },
		]);

		const kinds = (db.prepare("SELECT name FROM kinds WHERE name = 'playbook'").all() as Array<{ name: string }>).map((row) => row.name);
		expect(kinds).toEqual(["playbook"]);
		const statuses = (db.prepare("SELECT name FROM statuses WHERE kind = 'playbook' ORDER BY name").all() as Array<{ name: string }>).map(
			(row) => row.name,
		);
		expect(statuses).toEqual(["active", "deprecated"]);
		expect(db.prepare("SELECT name FROM kinds WHERE name = 'skill'").get()).toBeNull();
		db.close();
	});
});
