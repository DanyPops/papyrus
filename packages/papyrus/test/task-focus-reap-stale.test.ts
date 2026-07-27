import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { TASK_FOCUS_STALE_AFTER_MS } from "../src/constants.ts";
import { openDb, type Db } from "../src/db.ts";
import { InMemoryTaskFocusStore } from "../src/ports/task-focus-store.ts";
import { Tasks } from "../src/task-service.ts";

const gates = { run: () => [], runAsync: async () => [] };

function sqliteFixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const focusStore = new SQLiteTaskFocusStore(db);
	const tasks = new Tasks(artifacts, gates, focusStore);
	const backdate = (scope: string, updatedAt: string) => {
		db.prepare("UPDATE task_focus SET updated_at = ? WHERE scope = ?").run(updatedAt, scope);
	};
	return { tasks, backdate };
}

function inMemoryFixture() {
	const db: Db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const focusStore = new InMemoryTaskFocusStore();
	const tasks = new Tasks(artifacts, gates, focusStore);
	const backdate = (scope: string, updatedAt: string) => {
		const state = (focusStore as unknown as { state: Map<string, { updatedAt: string }> }).state;
		const entry = state.get(scope);
		if (entry) entry.updatedAt = updatedAt;
	};
	return { tasks, backdate };
}

const NOW = new Date("2024-06-15T00:00:00.000Z");
const JUST_UNDER_STALE = new Date(NOW.getTime() - (TASK_FOCUS_STALE_AFTER_MS - 60_000)).toISOString();
const JUST_OVER_STALE = new Date(NOW.getTime() - (TASK_FOCUS_STALE_AFTER_MS + 60_000)).toISOString();

describe("Tasks.reapStaleFocus — time-based reclamation, independent of the LRU cap", () => {
	for (const [name, makeFixture] of [["SQLiteTaskFocusStore", sqliteFixture], ["InMemoryTaskFocusStore", inMemoryFixture]] as const) {
		describe(name, () => {
			it("removes a Focus scope not updated in over TASK_FOCUS_STALE_AFTER_MS, keeps one just under the threshold", () => {
				const { tasks, backdate } = makeFixture();
				const stale = tasks.create({ title: "Stale" });
				const fresh = tasks.create({ title: "Fresh" });
				tasks.focus(stale.id, { sessionId: "session-stale" });
				tasks.focus(fresh.id, { sessionId: "session-fresh" });

				// Directly backdate updated_at past/under the threshold -- the real production
				// path is simply "nobody touched this Focus scope in N days", which real time
				// can't be waited out inside a test.
				backdate("session-stale", JUST_OVER_STALE);
				backdate("session-fresh", JUST_UNDER_STALE);

				const removed = tasks.reapStaleFocus(() => NOW.toISOString());
				expect(removed).toBe(1);
				expect(tasks.focused({ sessionId: "session-stale" })).toBeNull();
				expect(tasks.focused({ sessionId: "session-fresh" })?.artifact.id).toBe(fresh.id);
			});

			it("is a real no-op (returns 0, deletes nothing) when nothing is stale", () => {
				const { tasks } = makeFixture();
				const task = tasks.create({ title: "T" });
				tasks.focus(task.id, { sessionId: "session-a" });
				expect(tasks.reapStaleFocus(() => NOW.toISOString())).toBe(0);
				expect(tasks.focused({ sessionId: "session-a" })?.artifact.id).toBe(task.id);
			});

			it("does not touch a different, still-fresh session's Focus when reaping one that is stale", () => {
				const { tasks, backdate } = makeFixture();
				const a = tasks.create({ title: "A" });
				const b = tasks.create({ title: "B" });
				tasks.focus(a.id, { sessionId: "session-a" });
				tasks.focus(b.id, { sessionId: "session-b" });
				backdate("session-a", JUST_OVER_STALE);

				expect(tasks.reapStaleFocus(() => NOW.toISOString())).toBe(1);
				expect(tasks.focused({ sessionId: "session-a" })).toBeNull();
				expect(tasks.focused({ sessionId: "session-b" })?.artifact.id).toBe(b.id);
			});
		});
	}
});
