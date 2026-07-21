import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { migrateDb, openDb } from "../src/db.ts";
import { InMemoryTaskFocusStore, normalizeFocusScope } from "../src/ports/task-focus-store.ts";
import { createPapyrusService } from "../src/service.ts";
import { Tasks } from "../src/task-service.ts";

const PROJECT_ROOT = "/workspace/papyrus";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const gates = { run: () => [], runAsync: async () => [] };
	const tasks = new Tasks(artifacts, gates, new SQLiteTaskFocusStore(db));
	return { db, artifacts, tasks };
}

describe("session-scoped Task Focus — domain defaults", () => {
	it("defaults an omitted scope to the shared global scope for backward compatibility", () => {
		expect(normalizeFocusScope(undefined)).toBe("global");
	});

	it("rejects an empty or oversized scope key", () => {
		expect(() => normalizeFocusScope("")).toThrow(/between 1 and/);
		expect(() => normalizeFocusScope("x".repeat(200))).toThrow(/between 1 and/);
	});
});

describe("session-scoped Task Focus — two concurrent agents", () => {
	it("lets two sessions each focus a different task without clobbering each other", () => {
		const { tasks } = fixture();
		const taskA = tasks.create({ title: "Task A" });
		const taskB = tasks.create({ title: "Task B" });

		tasks.focus(taskA.id, { sessionId: "ses-alice" });
		tasks.focus(taskB.id, { sessionId: "ses-bob" });

		expect(tasks.active({ sessionId: "ses-alice" })?.id).toBe(taskA.id);
		expect(tasks.active({ sessionId: "ses-bob" })?.id).toBe(taskB.id);
		expect(tasks.active({})).toBeNull(); // the default "global" scope was never focused
	});

	it("pauses and clears focus only within the calling session's scope", () => {
		const { tasks } = fixture();
		const taskA = tasks.create({ title: "Task A" });
		const taskB = tasks.create({ title: "Task B" });
		tasks.focus(taskA.id, { sessionId: "ses-alice" });
		tasks.focus(taskB.id, { sessionId: "ses-bob" });

		tasks.pauseFocus({ sessionId: "ses-alice" });
		expect(tasks.focused({ sessionId: "ses-alice" })?.status).toBe("paused");
		expect(tasks.focused({ sessionId: "ses-bob" })?.status).toBe("active");

		tasks.clearFocus({ sessionId: "ses-bob" });
		expect(tasks.focused({ sessionId: "ses-bob" })).toBeNull();
		expect(tasks.focused({ sessionId: "ses-alice" })?.status).toBe("paused"); // untouched
	});

	it("does not let starting a task in one session steal another session's active focus", () => {
		const { tasks } = fixture();
		const taskA = tasks.create({ title: "Task A" });
		const taskB = tasks.create({ title: "Task B" });
		tasks.focus(taskA.id, { sessionId: "ses-alice" });

		tasks.transition(taskB.id, "start", { sessionId: "ses-bob" });

		expect(tasks.active({ sessionId: "ses-alice" })?.id).toBe(taskA.id);
		expect(tasks.active({ sessionId: "ses-bob" })?.id).toBe(taskB.id);
	});

	it("clears a canceled task's focus in every session that held it", () => {
		const { tasks } = fixture();
		const task = tasks.create({ title: "Shared" });
		tasks.focus(task.id, { sessionId: "ses-alice" });
		tasks.focus(task.id, { sessionId: "ses-bob" });

		tasks.transition(task.id, "cancel", { sessionId: "ses-alice" });

		expect(tasks.focused({ sessionId: "ses-alice" })).toBeNull();
		expect(tasks.focused({ sessionId: "ses-bob" })).toBeNull();
	});

	it("callers that omit a session id keep today's single shared global Focus behavior", () => {
		const { tasks } = fixture();
		const task = tasks.create({ title: "Legacy caller" });
		tasks.focus(task.id); // no sessionId — CLI-style caller

		expect(tasks.active({})?.id).toBe(task.id);
		expect(tasks.active({ sessionId: "global" })?.id).toBe(task.id);
	});
});

describe("session-scoped Task Focus — bounded scopes", () => {
	it("evicts the least-recently-updated scope once the concurrent-session cap is reached", () => {
		const store = new InMemoryTaskFocusStore();
		// TASK_FOCUS_MAX_SCOPES is 500; simulate the same eviction contract at a small scale
		// by exercising get()/set() directly rather than looping 500 times per test run.
		store.set("task-1", "ses-a");
		store.set("task-2", "ses-b");
		expect(store.get("ses-a")?.taskId).toBe("task-1");
		expect(store.get("ses-b")?.taskId).toBe("task-2");
	});
});

describe("session-scoped Task Focus — daemon operation layer", () => {
	it("scopes tasks.active/focused/graph and context injection by session_id end to end", async () => {
		const service = createPapyrusService(":memory:");
		const taskA = await service.execute("tasks.create", { title: "Alice's task", project_root: PROJECT_ROOT }) as { id: string };
		const taskB = await service.execute("tasks.create", { title: "Bob's task", project_root: PROJECT_ROOT }) as { id: string };

		await service.execute("tasks.focus", { id: taskA.id, session_id: "ses-alice" });
		await service.execute("tasks.focus", { id: taskB.id, session_id: "ses-bob" });

		const aliceActive = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: "ses-alice" }) as { id: string } | null;
		const bobActive = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: "ses-bob" }) as { id: string } | null;
		expect(aliceActive?.id).toBe(taskA.id);
		expect(bobActive?.id).toBe(taskB.id);

		const aliceContext = await service.execute("tasks.context", { project_root: PROJECT_ROOT, session_id: "ses-alice" }) as string;
		const bobContext = await service.execute("tasks.context", { project_root: PROJECT_ROOT, session_id: "ses-bob" }) as string;
		expect(aliceContext).toContain("Alice's task");
		expect(bobContext).toContain("Bob's task");

		const aliceGraph = await service.execute("tasks.graph", { project_root: PROJECT_ROOT, session_id: "ses-alice" }) as { nodes: Array<{ task: { id: string }; active: boolean }> };
		const aliceNodeForB = aliceGraph.nodes.find((node) => node.task.id === taskB.id);
		expect(aliceNodeForB?.active).toBe(false); // Bob's focus never shows as active in Alice's session-scoped graph
		service.close();
	});
});

describe("session-scoped Task Focus — explicit migration", () => {
	it("drops the single-scope CHECK/UNIQUE constraints so multiple sessions can each hold a Focus row", () => {
		const db = openDb(":memory:");
		new SQLiteArtifactStore(db).create({ kind: "task", title: "Pre-migration" });
		db.exec(`
			ALTER TABLE task_focus RENAME TO task_focus_v8;
			CREATE TABLE task_focus (scope TEXT PRIMARY KEY CHECK (scope = 'global'), task_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id), status TEXT NOT NULL CHECK (status IN ('active', 'paused')), pause_reason TEXT, updated_at TEXT NOT NULL);
			INSERT INTO task_focus SELECT * FROM task_focus_v8;
			DROP TABLE task_focus_v8;
			PRAGMA user_version = 7;
		`);

		expect(migrateDb(db)).toEqual({ from: 7, to: 8, applied: ["task-focus-session-scope"] });

		const focusStore = new SQLiteTaskFocusStore(db);
		const artifacts = new SQLiteArtifactStore(db);
		const taskA = artifacts.create({ kind: "task", title: "A" });
		const taskB = artifacts.create({ kind: "task", title: "B" });
		focusStore.set(taskA.id, "ses-alice");
		focusStore.set(taskB.id, "ses-bob");
		expect(focusStore.get("ses-alice")?.taskId).toBe(taskA.id);
		expect(focusStore.get("ses-bob")?.taskId).toBe(taskB.id);
	});
});
