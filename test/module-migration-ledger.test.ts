import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationLedger, migrateDb, openDb, schemaVersion } from "../src/db.ts";
import { SQLITE_SCHEMA_VERSION } from "../src/constants.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";

describe("module migration ledger", () => {
	it("backfills every entry in the core ledger history for a freshly bootstrapped database", () => {
		const db = openDb(":memory:");
		const ledger = migrationLedger(db);
		expect(ledger.length).toBeGreaterThanOrEqual(2); // every historical core version is backfilled, not just the latest
		expect(ledger[0]).toMatchObject({ moduleId: "core", version: 1, name: "baseline" });
		for (const row of ledger) {
			expect(row.checksum).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, not a placeholder
			expect(row.appliedAt).toBeTruthy();
		}
		expect(schemaVersion(db)).toBe(SQLITE_SCHEMA_VERSION); // PRAGMA user_version stays informational, still consistent
	});

	it("is stable and idempotent across repeated opens of the same file-backed database", () => {
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-ledger-")), "papyrus.db");
		const first = openDb(path);
		const firstLedger = migrationLedger(first);
		first.close();

		const second = openDb(path);
		const secondLedger = migrationLedger(second);
		second.close();

		expect(secondLedger).toEqual(firstLedger); // no duplicate rows, no re-applied migration, same checksum/appliedAt
	});

	it("backfills the ledger for a pre-ledger database that reached current schema through the old sequential upgrade path", () => {
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-ledger-legacy-")), "papyrus.db");
		// Simulate a real production database that upgraded via the historical migrateDb() chain
		// before the ledger existed: drop the ledger table bootstrapEmptyDatabase would have
		// created, keeping PRAGMA user_version at current -- exactly what a database persisted
		// before this change looks like on next open.
		const db = openDb(path);
		db.exec("DROP TABLE module_migrations");
		db.close();

		const reopened = openDb(path);
		const ledger = migrationLedger(reopened);
		expect(ledger.length).toBeGreaterThanOrEqual(2);
		expect(ledger[0]).toMatchObject({ moduleId: "core", version: 1, name: "baseline" });
		// Backfill must not re-run DDL against a database that already has all its tables and data.
		const artifact = new SQLiteArtifactStore(reopened).create({ kind: "doc", title: "Already here" });
		expect(artifact.id).toBeTruthy();
		reopened.close();
	});

	it("does not auto-migrate a genuinely outdated database on open -- explicit migration stays required", () => {
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-ledger-outdated-")), "papyrus.db");
		const legacy = new Database(path, { create: true });
		legacy.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE kinds (name TEXT PRIMARY KEY, description TEXT);
			CREATE TABLE statuses (name TEXT NOT NULL, kind TEXT NOT NULL REFERENCES kinds(name), PRIMARY KEY (name, kind));
			CREATE TABLE relation_names (name TEXT PRIMARY KEY, description TEXT);
			CREATE TABLE artifacts (
				id TEXT PRIMARY KEY, kind TEXT NOT NULL REFERENCES kinds(name), title TEXT NOT NULL,
				status TEXT NOT NULL, subtype TEXT DEFAULT '', body TEXT DEFAULT '', labels TEXT DEFAULT '[]',
				extra TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				FOREIGN KEY (kind, status) REFERENCES statuses(kind, name)
			);
			CREATE TABLE edges (
				from_id TEXT NOT NULL REFERENCES artifacts(id), relation TEXT NOT NULL REFERENCES relation_names(name),
				to_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY (from_id, relation, to_id)
			);
			INSERT INTO kinds VALUES ('task', 'legacy tasks');
			INSERT INTO statuses VALUES ('pending', 'task');
			PRAGMA user_version = 1;
		`);
		legacy.close();

		const db = openDb(path);
		expect(schemaVersion(db)).toBe(1); // openDb never silently upgrades
		expect(migrationLedger(db)).toEqual([]); // no backfill either -- this database is not yet at current schema
		db.close();
	});

	it("throws if a ledger row's stored checksum no longer matches its frozen definition", () => {
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-ledger-drift-")), "papyrus.db");
		const fresh = openDb(path);
		fresh.prepare("UPDATE module_migrations SET checksum = 'tampered' WHERE module_id = 'core' AND version = 1").run();
		fresh.close();
		expect(() => openDb(path)).toThrow(/checksum/);
	});

	it("regression: a database that only recorded an earlier core version (like the real, already-deployed production database) is backfilled with later versions, never mismatched", () => {
		// Reproduces the exact production incident this fix closes. Before this fix, "core
		// version 1"'s checksum was computed from the CURRENT SCHEMA+SEED_SQL text every time
		// the process started, so it silently redefined itself the moment SCHEMA grew for any
		// reason -- which would have thrown "checksum mismatch" against the real production
		// database (which had already recorded version 1 under an older, smaller schema) the
		// next time it opened under newer code, even though nothing about that database was
		// actually wrong. Simulate exactly that database shape: only version 1 recorded, none
		// of the later versions.
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-ledger-legacy-v1-only-")), "papyrus.db");
		const db = openDb(path);
		db.exec("DELETE FROM module_migrations WHERE version > 1");
		db.close();

		// Reopening (the same code path a daemon restart takes) must not throw, and must
		// backfill every later version without disturbing the already-recorded version 1.
		const reopened = openDb(path);
		const ledger = migrationLedger(reopened);
		const version1 = ledger.find((row) => row.version === 1)!;
		expect(version1.checksum).toBe("af81e9f51d915ba538af3f468dc044bda5e2c5a5f5037e9c7c01540f87288763"); // the real, already-deployed value, untouched
		expect(ledger.length).toBeGreaterThanOrEqual(2); // later versions were backfilled, not skipped or errored
		reopened.close();
	});

	it("keeps the pre-ledger explicit migrate path's behavior and reporting completely unchanged", () => {
		const path = join(mkdtempSync(join(tmpdir(), "papyrus-ledger-explicit-")), "papyrus.db");
		const legacy = new Database(path, { create: true });
		legacy.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE kinds (name TEXT PRIMARY KEY, description TEXT);
			CREATE TABLE statuses (name TEXT NOT NULL, kind TEXT NOT NULL REFERENCES kinds(name), PRIMARY KEY (name, kind));
			CREATE TABLE relation_names (name TEXT PRIMARY KEY, description TEXT);
			CREATE TABLE artifacts (
				id TEXT PRIMARY KEY, kind TEXT NOT NULL REFERENCES kinds(name), title TEXT NOT NULL,
				status TEXT NOT NULL, subtype TEXT DEFAULT '', body TEXT DEFAULT '', labels TEXT DEFAULT '[]',
				extra TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				FOREIGN KEY (kind, status) REFERENCES statuses(kind, name)
			);
			CREATE TABLE edges (
				from_id TEXT NOT NULL REFERENCES artifacts(id), relation TEXT NOT NULL REFERENCES relation_names(name),
				to_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY (from_id, relation, to_id)
			);
			INSERT INTO kinds VALUES ('task', 'legacy tasks');
			INSERT INTO statuses VALUES ('pending', 'task'), ('active', 'task'), ('done', 'task'), ('failed', 'task');
			PRAGMA user_version = 1;
		`);
		legacy.close();

		const db = openDb(path); // current < required: must NOT auto-migrate
		expect(schemaVersion(db)).toBe(1);
		const result = migrateDb(db); // explicit, authenticated path -- same as system.migrate
		expect(result.from).toBe(1);
		expect(result.to).toBe(SQLITE_SCHEMA_VERSION);
		expect(result.applied.length).toBeGreaterThan(0);
		const ledger = migrationLedger(db);
		expect(ledger.some((row) => row.moduleId === "core" && row.version === 1)).toBe(true);
		db.close();
	});
});
