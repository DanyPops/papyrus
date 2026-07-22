import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb } from "../src/db.ts";

/**
 * Regression coverage for a real, latent bug found while adding the v10->v11 (log-domain)
 * migration step: migrateDb()'s guard rejecting an unrecognized starting version was a
 * hand-enumerated allow-list ("from !== 1 && ... && from !== 7") that was never extended
 * when the v8->v9 and v9->v10 steps were added later. Any already-deployed database sitting
 * at schema 8, 9, or 10 -- including the real production database at the time this was
 * found -- would have thrown "no explicit migration path" before ever reaching the actual
 * migration chain. Fixed by checking dynamically (did the chain actually reach
 * SQLITE_SCHEMA_VERSION?) instead of a separate, driftable enumeration. These three cases
 * are the exact ones the old guard would have rejected.
 */
function freshDbAtVersion(version: number, dropLogTables: boolean): { path: string } {
	const path = join(mkdtempSync(join(tmpdir(), "papyrus-migration-guard-")), "papyrus.db");
	const db = openDb(path); // bootstraps at the full current schema
	if (dropLogTables) {
		db.exec(`
			DROP TRIGGER IF EXISTS log_entries_no_update;
			DROP INDEX IF EXISTS log_entries_source_idx;
			DROP TABLE IF EXISTS log_entries;
			DROP TABLE IF EXISTS log_sources;
		`);
	}
	db.exec(`PRAGMA user_version = ${version}`);
	db.close();
	return { path };
}

describe("migrateDb guard regression: schema versions 8, 9, 10 must have a real migration path", () => {
	it("migrates from schema version 10 (today's real, live production shape) to current", () => {
		const { path } = freshDbAtVersion(10, true);
		const db = openDb(path);
		const result = migrateDb(db);
		expect(result.from).toBe(10);
		expect(result.applied).toEqual(["log-domain"]);
		expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'log_sources'").get()).not.toBeNull();
		db.close();
	});

	it("migrates from schema version 9 to current (the version the old guard would have rejected first)", () => {
		const { path } = freshDbAtVersion(9, true);
		const db = openDb(path);
		const result = migrateDb(db);
		expect(result.from).toBe(9);
		expect(result.applied).toEqual(["docs-rules-skills-project-scope", "log-domain"]);
		db.close();
	});

	it("migrates from schema version 8 to current", () => {
		const { path } = freshDbAtVersion(8, true);
		const db = openDb(path);
		const result = migrateDb(db);
		expect(result.from).toBe(8);
		expect(result.applied).toEqual(["graph-projection-protocol", "docs-rules-skills-project-scope", "log-domain"]);
		db.close();
	});

	it("still rejects a genuinely invalid/unversioned starting point (0) rather than silently no-op-ing", () => {
		// Deliberately does not round-trip through openDb() (its own current===0 bootstrap path
		// intercepts that case before migrateDb ever runs) -- this exercises migrateDb's own
		// `from < 1` guard directly, on a still-open handle whose version was forced to 0 without closing.
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-migration-guard-")), "papyrus.db");
		const db = openDb(path);
		db.exec("PRAGMA user_version = 0");
		expect(() => migrateDb(db)).toThrow(/no explicit migration path from database schema 0/);
		db.close();
	});
});
