import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskEventStore } from "../src/adapters/sqlite-task-event-store.ts";
import { TASK_EVENT_FEED_MAX_LIMIT } from "../src/constants.ts";
import { openDb } from "../src/db.ts";
import type { GateRunner } from "../src/ports/gate-runner.ts";
import { InMemoryTaskEventStore } from "../src/ports/task-event-store.ts";
import { Tasks } from "../src/task-service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const passingGates: GateRunner = { run: () => [], runAsync: async () => [] };

function sqliteFixture() {
	const dir = tempDir("papyrus-task-event-feed-");
	const db = openDb(join(dir, "papyrus.db"));
	const artifacts = new SQLiteArtifactStore(db);
	const events = new SQLiteTaskEventStore(db);
	return { tasks: new Tasks(artifacts, passingGates, undefined, events), events };
}

function inMemoryFixture() {
	const artifacts = new SQLiteArtifactStore(openDb(":memory:"));
	const events = new InMemoryTaskEventStore();
	return { tasks: new Tasks(artifacts, passingGates, undefined, events), events };
}

for (const [name, makeFixture] of [
	["SQLiteTaskEventStore", sqliteFixture],
	["InMemoryTaskEventStore", inMemoryFixture],
] as const) {
	describe(`TaskEventStore.feed \u2014 ${name}`, () => {
		it("replays every event across every task, globally sequenced, not scoped to one taskId like history()", () => {
			const { tasks, events } = makeFixture();
			const a = tasks.create({ title: "A" });
			const b = tasks.create({ title: "B" });
			const page = events.feed();
			expect(page.events.map((event) => event.taskId)).toEqual([a.id, b.id]);
			expect(page.events.map((event) => event.type)).toEqual(["created", "created"]);
		});

		it("resumes exactly where a cursor left off", () => {
			const { tasks, events } = makeFixture();
			const a = tasks.create({ title: "A" });
			const b = tasks.create({ title: "B" });
			const first = events.feed({ limit: 1 });
			expect(first.events.map((event) => event.taskId)).toEqual([a.id]);
			expect(first.nextCursor).toBeDefined();
			const resumed = events.feed({ cursor: first.nextCursor });
			expect(resumed.events.map((event) => event.taskId)).toEqual([b.id]);
		});

		it("filters by eventTypes -- the primary way a readiness-only subscriber avoids noise", () => {
			const { tasks, events } = makeFixture();
			const root = tasks.create({ title: "Root", status: "review" });
			tasks.create({ title: "Successor", dependsOn: [root.id] });
			tasks.complete(root.id);
			const readyOnly = events.feed({ eventTypes: ["became_ready"] });
			expect(readyOnly.events.map((event) => event.type)).toEqual(["became_ready"]);
		});

		it("sets nextCursor only when more events remain beyond the page, matching history()'s own convention", () => {
			const { tasks, events } = makeFixture();
			tasks.create({ title: "A" });
			tasks.create({ title: "B" });
			const exact = events.feed({ limit: 2 });
			expect(exact.nextCursor).toBeUndefined();
			const partial = events.feed({ limit: 1 });
			expect(partial.nextCursor).toBeDefined();
		});

		it("rejects a limit outside the bound, an unknown event type, and an empty eventTypes array", () => {
			const { events } = makeFixture();
			expect(() => events.feed({ limit: 0 })).toThrow(/limit must be between/);
			expect(() => events.feed({ limit: TASK_EVENT_FEED_MAX_LIMIT + 1 })).toThrow(/limit must be between/);
			expect(() => events.feed({ eventTypes: ["not-a-real-type" as never] })).toThrow(/unknown task event type/);
			expect(() => events.feed({ eventTypes: [] })).toThrow(/must be non-empty/);
		});
	});
}
