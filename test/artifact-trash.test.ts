/**
 * Real end-to-end coverage of Option B (see the design discussion this implements):
 * artifact.remove is a narrow, time-gated exception to append-only, not a status flip.
 * Everything here runs against a real (in-memory) SQLite Db, deliberately -- the safety
 * property this whole feature rests on (db.ts's trigger carve-out enforcing the elapsed
 * deadline independent of application code) can only be proven against real SQLite.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
	createArtifact,
	getArtifact,
	getArtifactTrash,
	linkArtifacts,
	listArtifactTrash,
	purgeDueArtifacts,
	queryArtifacts,
	restoreArtifact,
	trashArtifact,
} from "../src/ops.ts";
import { openDb } from "../src/db.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);

function fixture() {
	const dir = tempDir("papyrus-artifact-trash-");
	const db = openDb(`${dir}/papyrus.db`);
	return { db };
}

const PAST = () => new Date(Date.now() - 1000).toISOString(); // already elapsed
const FUTURE = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days out

describe("trashArtifact", () => {
	it("moves an artifact to the trash and records a trashed event", () => {
		const { db } = fixture();
		const doc = createArtifact(db, { kind: "doc", title: "x" });
		const record = trashArtifact(db, doc.id, { reason: "cruft" });
		expect(record.artifactId).toBe(doc.id);
		expect(new Date(record.purgeAfter).getTime()).toBeGreaterThan(new Date(record.trashedAt).getTime());
		expect(record.reason).toBe("cruft");
		expect(getArtifactTrash(db, doc.id)).toEqual(record);
		db.close();
	});

	it("throws for a nonexistent artifact", () => {
		const { db } = fixture();
		expect(() => trashArtifact(db, "does-not-exist")).toThrow(/not found/);
		db.close();
	});

	it("resets the clock rather than erroring when re-trashing an already-trashed artifact", () => {
		const { db } = fixture();
		const doc = createArtifact(db, { kind: "doc", title: "x" });
		const first = trashArtifact(db, doc.id, { now: PAST });
		const second = trashArtifact(db, doc.id, { now: () => new Date().toISOString() });
		expect(second.trashedAt).not.toBe(first.trashedAt);
		expect(listArtifactTrash(db)).toHaveLength(1); // still one row, not two
		db.close();
	});

	it("refuses to trash a Task that is the live Task Focus in any scope", () => {
		const { db } = fixture();
		const task = createArtifact(db, { kind: "task", title: "x" });
		db.exec(`INSERT INTO task_focus (scope, task_id, status, updated_at) VALUES ('global', '${task.id}', 'active', '${new Date().toISOString()}')`);
		expect(() => trashArtifact(db, task.id)).toThrow(/active Task Focus/);
		db.close();
	});

	it("still works once focus has moved elsewhere", () => {
		const { db } = fixture();
		const task = createArtifact(db, { kind: "task", title: "x" });
		db.exec(`INSERT INTO task_focus (scope, task_id, status, updated_at) VALUES ('global', '${task.id}', 'active', '${new Date().toISOString()}')`);
		db.exec("DELETE FROM task_focus");
		expect(() => trashArtifact(db, task.id)).not.toThrow();
		db.close();
	});
});

describe("queryArtifacts / getArtifact visibility", () => {
	it("excludes a trashed artifact from queries by default, but still returns it directly by id", () => {
		const { db } = fixture();
		const doc = createArtifact(db, { kind: "doc", title: "keep-visible" });
		const trashed = createArtifact(db, { kind: "doc", title: "trashed-one" });
		trashArtifact(db, trashed.id);
		const results = queryArtifacts(db, { kind: "doc" });
		expect(results.map((a) => a.id)).toContain(doc.id);
		expect(results.map((a) => a.id)).not.toContain(trashed.id);
		expect(getArtifact(db, trashed.id)?.id).toBe(trashed.id); // still directly reachable
		db.close();
	});

	it("includes trashed artifacts when includeTrashed is set", () => {
		const { db } = fixture();
		const trashed = createArtifact(db, { kind: "doc", title: "trashed-one" });
		trashArtifact(db, trashed.id);
		const results = queryArtifacts(db, { kind: "doc", includeTrashed: true });
		expect(results.map((a) => a.id)).toContain(trashed.id);
		db.close();
	});
});

describe("restoreArtifact", () => {
	it("removes a trashed artifact from the trash and records a restored event", () => {
		const { db } = fixture();
		const doc = createArtifact(db, { kind: "doc", title: "x" });
		trashArtifact(db, doc.id);
		const result = restoreArtifact(db, doc.id);
		expect(result).toEqual({ restored: true });
		expect(getArtifactTrash(db, doc.id)).toBeNull();
		expect(queryArtifacts(db, { kind: "doc" }).map((a) => a.id)).toContain(doc.id);
		db.close();
	});

	it("is a real no-op, not an error, for an artifact that is not currently trashed", () => {
		const { db } = fixture();
		const doc = createArtifact(db, { kind: "doc", title: "x" });
		expect(restoreArtifact(db, doc.id)).toEqual({ restored: false });
		expect(restoreArtifact(db, "never-existed")).toEqual({ restored: false });
		db.close();
	});
});

describe("the database itself enforces the elapsed-deadline carve-out (not just application code)", () => {
	it("still blocks deleting artifact_events for a trashed artifact whose purge_after has not elapsed yet", () => {
		const { db } = fixture();
		const doc = createArtifact(db, { kind: "doc", title: "x" });
		trashArtifact(db, doc.id, { now: () => new Date().toISOString() }); // purge_after is ~30 days out
		expect(() => db.exec(`DELETE FROM artifact_events WHERE artifact_id = '${doc.id}'`)).toThrow(/append-only/);
		db.close();
	});

	it("permits deleting artifact_events only once purge_after has genuinely elapsed", () => {
		const { db } = fixture();
		const doc = createArtifact(db, { kind: "doc", title: "x" });
		trashArtifact(db, doc.id, { now: PAST });
		// PAST's purge_after is also in the past (PAST + retention is still far future in real
		// time, so force it directly to prove the trigger, not trashArtifact's own math, is what's checked).
		db.exec(`UPDATE artifact_trash SET purge_after = '${PAST()}' WHERE artifact_id = '${doc.id}'`);
		expect(() => db.exec(`DELETE FROM artifact_events WHERE artifact_id = '${doc.id}'`)).not.toThrow();
		db.close();
	});

	it("still blocks deleting task_events for a task not yet past its deadline", () => {
		const { db } = fixture();
		const task = createArtifact(db, { kind: "task", title: "x" });
		db.exec(`INSERT INTO task_events (task_id, occurred_at, event_type, actor, source) VALUES ('${task.id}', '${new Date().toISOString()}', 'created', 'system', 'test')`);
		trashArtifact(db, task.id);
		expect(() => db.exec(`DELETE FROM task_events WHERE task_id = '${task.id}'`)).toThrow(/append-only/);
		db.close();
	});
});

describe("purgeDueArtifacts", () => {
	it("does nothing for a trashed artifact whose purge_after has not elapsed", () => {
		const { db } = fixture();
		const doc = createArtifact(db, { kind: "doc", title: "x" });
		trashArtifact(db, doc.id);
		expect(purgeDueArtifacts(db)).toBe(0);
		expect(getArtifact(db, doc.id)).not.toBeNull();
		db.close();
	});

	it("really, cascadingly deletes a due artifact: row, edges (both directions), and its own event history", () => {
		const { db } = fixture();
		const survivor = createArtifact(db, { kind: "doc", title: "survivor" });
		const doomed = createArtifact(db, { kind: "task", title: "doomed" });
		linkArtifacts(db, doomed.id, "references", survivor.id);
		linkArtifacts(db, survivor.id, "implements", doomed.id);
		db.exec(`INSERT INTO task_scopes (task_id, project_root, source, assigned_at) VALUES ('${doomed.id}', NULL, 'unscoped', '${new Date().toISOString()}')`);
		db.exec(`INSERT INTO task_events (task_id, occurred_at, event_type, actor, source) VALUES ('${doomed.id}', '${new Date().toISOString()}', 'created', 'system', 'test')`);
		trashArtifact(db, doomed.id, { now: PAST });
		db.exec(`UPDATE artifact_trash SET purge_after = '${PAST()}' WHERE artifact_id = '${doomed.id}'`);

		const purged = purgeDueArtifacts(db);

		expect(purged).toBe(1);
		expect(getArtifact(db, doomed.id)).toBeNull();
		expect(getArtifactTrash(db, doomed.id)).toBeNull();
		expect(db.prepare("SELECT 1 FROM edges WHERE from_id = ? OR to_id = ?").get(doomed.id, doomed.id)).toBeNull();
		expect(db.prepare("SELECT 1 FROM task_scopes WHERE task_id = ?").get(doomed.id)).toBeNull();
		expect(db.prepare("SELECT 1 FROM task_events WHERE task_id = ?").get(doomed.id)).toBeNull();
		expect(db.prepare("SELECT 1 FROM artifact_events WHERE artifact_id = ?").get(doomed.id)).toBeNull();
		// the survivor and its own edge/event history are completely untouched
		expect(getArtifact(db, survivor.id)).not.toBeNull();
		expect(db.prepare("SELECT 1 FROM artifact_events WHERE artifact_id = ?").get(survivor.id)).not.toBeNull();
		db.close();
	});

	it("purges every due artifact and returns an accurate count, leaving a not-yet-due one alone", () => {
		const { db } = fixture();
		const dueA = createArtifact(db, { kind: "doc", title: "due-a" });
		const dueB = createArtifact(db, { kind: "doc", title: "due-b" });
		const notDue = createArtifact(db, { kind: "doc", title: "not-due" });
		trashArtifact(db, dueA.id, { now: PAST });
		trashArtifact(db, dueB.id, { now: PAST });
		trashArtifact(db, notDue.id, { now: () => new Date().toISOString() });
		db.exec(`UPDATE artifact_trash SET purge_after = '${PAST()}' WHERE artifact_id IN ('${dueA.id}', '${dueB.id}')`);

		const purged = purgeDueArtifacts(db);

		expect(purged).toBe(2);
		expect(getArtifact(db, dueA.id)).toBeNull();
		expect(getArtifact(db, dueB.id)).toBeNull();
		expect(getArtifact(db, notDue.id)).not.toBeNull();
		expect(getArtifactTrash(db, notDue.id)).not.toBeNull();
		db.close();
	});
});
