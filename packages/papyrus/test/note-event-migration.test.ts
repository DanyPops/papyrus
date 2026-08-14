import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { migrateDb, openDb } from "../src/db.ts";
import { SQLiteNoteEventStore } from "../src/stores/sqlite-note-event-store.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

describe("note-events migration: existing extra.noteHistory blobs are preserved, not fabricated or dropped", () => {
	it("migrates a pre-v21 database's noteHistory blob into real note_events rows, and strips the retired field from extra", () => {
		const path = join(tempDir("papyrus-note-events-"), "papyrus.db");
		let db = openDb(path); // bootstraps at the full current schema, including note_events
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO artifacts (id, kind, subtype, title, status, body, labels, extra, created_at, updated_at)
			VALUES ('note-1', 'doc', 'note', 'Old note', 'archived', 'Body text', '["note","inbox"]', ?, ?, ?)
		`).run(
			JSON.stringify({
				projectRoot: "/workspace/papyrus",
				disposition: { kind: "promoted", targetId: "task-1" },
				noteHistory: [
					{ action: "captured", at: now, actor: "human", source: "command" },
					{
						action: "promoted",
						at: now,
						actor: "agent",
						source: "notes-tool",
						targetId: "task-1",
						disposition: "promoted",
						reason: "Converted to durable research",
					},
				],
			}),
			now,
			now,
		);
		// Simulate a pre-v21 database: drop the table this migration itself creates.
		db.exec(`
			DROP TRIGGER note_events_no_update;
			DROP TRIGGER note_events_no_delete;
			DROP INDEX note_events_history_idx;
			DROP TABLE note_events;
			PRAGMA user_version = 20;
		`);
		db.close();

		db = openDb(path);
		expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(20);
		const result = migrateDb(db);
		expect(result.from).toBe(20);
		expect(result.applied).toEqual([
			"note-events",
			"skill-to-playbook-data-migration",
			"retire-skill-kind",
			"artifact-aliases",
			"rule-draft-status",
			"task-projects-and-create-idempotency",
			"task-lifecycle-mutation-receipts",
			"artifact-multi-project-scope",
			"artifact-scope-tri-state-and-scope-groups",
		]);

		const events = new SQLiteNoteEventStore(db).history("note-1", { direction: "asc" });
		expect(events.events).toEqual([
			expect.objectContaining({ noteId: "note-1", type: "captured", actor: "human", source: "command" }),
			expect.objectContaining({
				noteId: "note-1",
				type: "promoted",
				actor: "agent",
				source: "notes-tool",
				relatedId: "task-1",
				disposition: "promoted",
				reason: "Converted to durable research",
			}),
		]);

		const extra = JSON.parse((db.prepare("SELECT extra FROM artifacts WHERE id = 'note-1'").get() as { extra: string }).extra) as Record<
			string,
			unknown
		>;
		expect(extra).toEqual({ projectRoot: "/workspace/papyrus", disposition: { kind: "promoted", targetId: "task-1" } });
		expect(extra).not.toHaveProperty("noteHistory");
		db.close();
	});

	it("is a no-op for a Note with no noteHistory at all -- nothing to migrate, nothing fabricated", () => {
		const path = join(tempDir("papyrus-note-events-"), "papyrus.db");
		let db = openDb(path);
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO artifacts (id, kind, subtype, title, status, body, labels, extra, created_at, updated_at)
			VALUES ('note-2', 'doc', 'note', 'Bare note', 'draft', 'Body text', '["note","inbox"]', ?, ?, ?)
		`).run(JSON.stringify({ projectRoot: "/workspace/papyrus" }), now, now);
		db.exec(`
			DROP TRIGGER note_events_no_update;
			DROP TRIGGER note_events_no_delete;
			DROP INDEX note_events_history_idx;
			DROP TABLE note_events;
			PRAGMA user_version = 20;
		`);
		db.close();

		db = openDb(path);
		migrateDb(db);
		expect(new SQLiteNoteEventStore(db).history("note-2").events).toEqual([]);
		const extra = JSON.parse((db.prepare("SELECT extra FROM artifacts WHERE id = 'note-2'").get() as { extra: string }).extra) as Record<
			string,
			unknown
		>;
		expect(extra).toEqual({ projectRoot: "/workspace/papyrus" });
		db.close();
	});
});
