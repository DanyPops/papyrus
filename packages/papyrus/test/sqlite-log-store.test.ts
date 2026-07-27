import { describe, expect, it } from "bun:test";
import { openDb } from "../src/db.ts";
import { SQLiteLogStore } from "../src/adapters/sqlite-log-store.ts";
import { Logs } from "../src/log-service.ts";

/**
 * Real SQLite round-trip coverage -- test/log-service.test.ts proves the service's own logic
 * against an in-memory fake, but that fake never touches a real database, real column types,
 * or the real log_entries_no_update trigger. This is the walking-skeleton proof: the same
 * Logs service, wired to the real adapter, against a real (in-memory) SQLite connection.
 */
describe("SQLiteLogStore", () => {
	it("round-trips an appended entry through real SQLite, including structured fields", () => {
		const db = openDb(":memory:");
		const logs = new Logs(new SQLiteLogStore(db));
		const result = logs.append({
			sourceId: "pi-session-context", sourceLabel: "Pi session context", level: "info",
			message: "turn settled", operationId: "session-1:turn-1",
			fields: { totalTokens: 12345, effectiveBudget: 180000, segments: ["rules", "tasks"] },
			sessionId: "session-1",
		});
		expect(result.replayed).toBe(false);

		const page = logs.query({ sourceId: "pi-session-context" });
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]!.message).toBe("turn settled");
		expect(page.entries[0]!.fields).toEqual({ totalTokens: 12345, effectiveBudget: 180000, segments: ["rules", "tasks"] });
		expect(page.entries[0]!.sessionId).toBe("session-1");
		db.close();
	});

	it("is idempotent across real inserts: replaying an operationId does not create a second row", () => {
		const db = openDb(":memory:");
		const logs = new Logs(new SQLiteLogStore(db));
		logs.append({ sourceId: "s", level: "info", message: "first", operationId: "op-1" });
		logs.append({ sourceId: "s", level: "info", message: "first, replayed", operationId: "op-1" });
		const count = db.prepare("SELECT COUNT(*) AS count FROM log_entries WHERE source_id = ?").get("s") as { count: number };
		expect(count.count).toBe(1);
		db.close();
	});

	it("enforces the real UNIQUE(source_id, operation_id) constraint at the schema level", () => {
		const db = openDb(":memory:");
		const store = new SQLiteLogStore(db);
		store.ensureSource("s", "S", null);
		store.insertEntry({ id: "e1", sourceId: "s", occurredAt: "2024-01-01T00:00:00.000Z", level: "info", message: "m", truncated: false, fields: {}, operationId: "dup" });
		expect(() => store.insertEntry({ id: "e2", sourceId: "s", occurredAt: "2024-01-01T00:00:01.000Z", level: "info", message: "m2", truncated: false, fields: {}, operationId: "dup" })).toThrow();
		db.close();
	});

	it("real log_entries rows are immutable -- the schema's own trigger rejects an UPDATE", () => {
		const db = openDb(":memory:");
		const store = new SQLiteLogStore(db);
		store.ensureSource("s", "S", null);
		store.insertEntry({ id: "e1", sourceId: "s", occurredAt: "2024-01-01T00:00:00.000Z", level: "info", message: "m", truncated: false, fields: {}, operationId: "op-1" });
		expect(() => db.prepare("UPDATE log_entries SET message = 'tampered' WHERE id = ?").run("e1")).toThrow(/immutable/);
		db.close();
	});

	it("real retention trimming deletes actual rows from the database, not just an in-memory view", () => {
		const db = openDb(":memory:");
		const store = new SQLiteLogStore(db);
		store.ensureSource("s", "S", null);
		for (let index = 0; index < 5; index++) {
			store.insertEntry({ id: `e${index}`, sourceId: "s", occurredAt: `2024-01-01T00:00:0${index}.000Z`, level: "info", message: `m${index}`, truncated: false, fields: {}, operationId: `op-${index}` });
		}
		const removed = store.trimSource("s", 2);
		expect(removed).toBe(3);
		const remaining = db.prepare("SELECT id FROM log_entries WHERE source_id = ? ORDER BY occurred_at").all("s") as Array<{ id: string }>;
		expect(remaining.map((row) => row.id)).toEqual(["e3", "e4"]);
		db.close();
	});

	it("persists projectRoot on the source row, defaulting to null when omitted", () => {
		const db = openDb(":memory:");
		const store = new SQLiteLogStore(db);
		const scoped = store.ensureSource("scoped-source", "Scoped", "/home/user/project");
		expect(scoped.projectRoot).toBe("/home/user/project");
		const unscoped = store.ensureSource("unscoped-source", "Unscoped", null);
		expect(unscoped.projectRoot).toBeNull();
		db.close();
	});
});
