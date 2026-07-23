/**
 * Proves the actual adoption: @danypops/daemon-kit's generic runMigrations engine (built
 * against bun:sqlite's concrete Database) genuinely runs, unmodified, against Papyrus's own
 * dual-runtime Db abstraction via dbMigrationRunner -- the exact reuse daemon-kit's storage
 * module was refactored (v0.2.1) to allow. This does not touch or depend on the frozen
 * legacy 1-13 migration chain in db.ts; it exercises the adapter directly with its own
 * throwaway migrations, against a real (in-memory) Papyrus database.
 */
import { describe, expect, it } from "bun:test";
import { runMigrations, type Migration } from "@danypops/daemon-kit/storage";
import { dbMigrationRunner, openDb, schemaVersion, type Db } from "../src/db.ts";

function freshDb(): Db {
	// openDb bootstraps a brand-new :memory: database directly at Papyrus's current schema
	// (13 today); PRAGMA user_version already reflects that, giving runMigrations a real,
	// non-zero starting version to build past -- exactly the composition migrateDb uses.
	return openDb(":memory:");
}

describe("dbMigrationRunner + daemon-kit's runMigrations, against a real Papyrus Db", () => {
	it("applies a migration beyond the database's current version and advances PRAGMA user_version", () => {
		const db = freshDb();
		const startVersion = schemaVersion(db);
		const migrations: Migration<Db>[] = [
			{ version: startVersion + 1, up: (handle) => handle.exec("CREATE TABLE adoption_probe (id INTEGER PRIMARY KEY)") },
		];

		runMigrations(dbMigrationRunner(db), migrations);

		expect(schemaVersion(db)).toBe(startVersion + 1);
		expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adoption_probe'").get()).not.toBeNull();
		db.close();
	});

	it("is idempotent: re-running the same migration list against an already-migrated database is a no-op", () => {
		const db = freshDb();
		const startVersion = schemaVersion(db);
		let runs = 0;
		const migrations: Migration<Db>[] = [
			{ version: startVersion + 1, up: (handle) => { handle.exec("CREATE TABLE adoption_probe (id INTEGER PRIMARY KEY)"); runs += 1; } },
		];

		runMigrations(dbMigrationRunner(db), migrations);
		runMigrations(dbMigrationRunner(db), migrations);

		expect(runs).toBe(1);
		expect(schemaVersion(db)).toBe(startVersion + 1);
		db.close();
	});

	it("applies multiple migrations in ascending order through Papyrus's own inTransaction", () => {
		const db = freshDb();
		const startVersion = schemaVersion(db);
		const order: number[] = [];
		const migrations: Migration<Db>[] = [
			{ version: startVersion + 2, up: () => order.push(2) },
			{ version: startVersion + 1, up: () => order.push(1) }, // deliberately out of array order
		];

		runMigrations(dbMigrationRunner(db), migrations);

		expect(order).toEqual([1, 2]);
		expect(schemaVersion(db)).toBe(startVersion + 2);
		db.close();
	});

	it("rejects a migration list with a version gap, via daemon-kit's own gap check", () => {
		const db = freshDb();
		const startVersion = schemaVersion(db);
		const migrations: Migration<Db>[] = [
			{ version: startVersion + 1, up: () => {} },
			{ version: startVersion + 3, up: () => {} }, // gap: startVersion + 2 missing
		];

		expect(() => runMigrations(dbMigrationRunner(db), migrations)).toThrow(/migration gap/);
		db.close();
	});

	it("rejects a database newer than every supplied migration -- a downgrade, not silently opened", () => {
		const db = freshDb();
		const startVersion = schemaVersion(db);

		expect(() => runMigrations(dbMigrationRunner(db), [{ version: startVersion - 1, up: () => {} }])).toThrow(
			new RegExp(`database schema ${startVersion} is newer than supported ${startVersion - 1}`),
		);
		db.close();
	});

	it("rolls back a failing migration through Papyrus's real SAVEPOINT-based inTransaction, leaving the version unchanged", () => {
		const db = freshDb();
		const startVersion = schemaVersion(db);
		const migrations: Migration<Db>[] = [
			{
				version: startVersion + 1,
				up: (handle) => {
					handle.exec("CREATE TABLE adoption_rollback_probe (id INTEGER PRIMARY KEY)");
					throw new Error("simulated migration failure");
				},
			},
		];

		expect(() => runMigrations(dbMigrationRunner(db), migrations)).toThrow(/simulated migration failure/);
		expect(schemaVersion(db)).toBe(startVersion); // never advanced
		expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adoption_rollback_probe'").get()).toBeNull();
		db.close();
	});
});
