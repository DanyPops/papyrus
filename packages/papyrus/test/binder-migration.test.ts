import { describe, expect, it } from "bun:test";
import { SQLITE_SCHEMA_VERSION } from "../src/constants.ts";
import { migrateDb, openDb } from "../src/db.ts";

describe("Binder schema migration", () => {
	it("upgrades schema 30 with the Binder kind, status, and dedicated relation pair", () => {
		const db = openDb(":memory:");
		db.exec(`
			DELETE FROM relation_names WHERE name IN ('organizes', 'filed_in');
			DELETE FROM statuses WHERE kind = 'binder';
			DELETE FROM kinds WHERE name = 'binder';
			PRAGMA user_version = 30;
		`);

		expect(migrateDb(db)).toEqual({
			from: 30,
			to: SQLITE_SCHEMA_VERSION,
			applied: ["binder-hierarchy-and-label-inheritance"],
		});
		expect(db.prepare("SELECT 1 FROM kinds WHERE name = 'binder'").get()).not.toBeNull();
		expect(db.prepare("SELECT 1 FROM statuses WHERE kind = 'binder' AND name = 'active'").get()).not.toBeNull();
		expect(
			(
				db.prepare("SELECT name FROM relation_names WHERE name IN ('organizes', 'filed_in') ORDER BY name").all() as Array<{ name: string }>
			).map((row) => row.name),
		).toEqual(["filed_in", "organizes"]);
		db.close();
	});
});
