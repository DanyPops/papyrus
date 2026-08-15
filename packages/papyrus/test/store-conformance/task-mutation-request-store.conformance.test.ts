import { describe, expect, it } from "bun:test";
import { type Db, openDb } from "../../src/db.ts";
import { createArtifact } from "../../src/ops.ts";
import { SQLiteTaskMutationRequestStore } from "../../src/task/mutation-request/sqlite-task-mutation-request-store.ts";
import {
	InMemoryTaskMutationRequestStore,
	TaskMutationPendingError,
	type TaskMutationRequestRecord,
	type TaskMutationRequestStore,
} from "../../src/task/mutation-request/task-mutation-request-store.ts";

/**
 * Runs one shared assertion suite against every real TaskMutationRequestStore implementation --
 * the same idea as vehicle-conformance (sibling vehicle project), applied to Papyrus's own
 * dual InMemory/SQLite store pairs. Both implementations honor the same contract *today* (verified
 * by reading both side by side during a SOLID audit), but they enforce "at most one pending
 * mutation per (taskId, operation)" through two structurally different mechanisms -- an
 * application-level pre-check in the in-memory store vs. a database UNIQUE INDEX caught and
 * re-derived in the SQLite store. Nothing catches those two mechanisms silently diverging unless
 * one shared test exercises both concrete classes against the identical interface contract,
 * instead of each store only ever being tested against its own hand-written expectations.
 */
function record(overrides: Partial<TaskMutationRequestRecord> = {}): TaskMutationRequestRecord {
	const now = new Date().toISOString();
	return {
		scope: "anonymous",
		key: "key-1",
		receiptId: crypto.randomUUID(),
		taskId: "task-1",
		operation: "submit",
		requestHash: "hash-1",
		state: "pending",
		createdAt: now,
		updatedAt: now,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		...overrides,
	};
}

/**
 * Real Task artifacts for every taskId this suite's fixtures reference, keyed by the same literal
 * ids `record()` uses ("task-1", "task-2", "task-99") -- the schema's own `task_id TEXT REFERENCES
 * artifacts(id)` foreign key means SQLiteTaskMutationRequestStore genuinely requires a real backing
 * artifact row, unlike the in-memory store which has no such constraint. Seeding real artifacts
 * (via the same createArtifact() production code path, not a hand-rolled INSERT) keeps this
 * fixture honest about what the SQLite backend actually requires in production, and is a no-op for
 * the in-memory backend (which never looks at the artifacts table at all).
 */
function seedTaskArtifacts(db: Db | undefined): void {
	if (!db) return;
	for (const id of ["task-1", "task-2", "task-99"]) {
		createArtifact(db, { kind: "task", title: id, id });
	}
}

const backends: Array<{ name: string; create: () => { store: TaskMutationRequestStore; db?: Db } }> = [
	{ name: "InMemoryTaskMutationRequestStore", create: () => ({ store: new InMemoryTaskMutationRequestStore() }) },
	{
		name: "SQLiteTaskMutationRequestStore",
		create: () => {
			const db = openDb(":memory:");
			return { store: new SQLiteTaskMutationRequestStore(db), db };
		},
	},
];

for (const backend of backends) {
	describe(`TaskMutationRequestStore conformance: ${backend.name}`, () => {
		const make = (): TaskMutationRequestStore => {
			const { store, db } = backend.create();
			seedTaskArtifacts(db);
			return store;
		};

		it("put() then get() round-trips every field, unaffected by expiry until it actually passes", () => {
			const store = make();
			const now = new Date().toISOString();
			const rec = record({ createdAt: now, updatedAt: now });
			store.put(rec);
			expect(store.get(rec.scope, rec.key, now)).toEqual(rec);
			expect(store.get(rec.scope, rec.key, rec.expiresAt)).toBeUndefined();
		});

		it("get() returns undefined for a key that was never put()", () => {
			const store = make();
			expect(store.get("anonymous", "never-existed", new Date().toISOString())).toBeUndefined();
		});

		it("get() is scoped by (scope, key) jointly -- neither alone is enough to collide", () => {
			const store = make();
			const now = new Date().toISOString();
			// Different taskIds here, deliberately: the pending-uniqueness invariant below is keyed by
			// (taskId, operation) GLOBALLY, with no scope column at all (confirmed against the real
			// schema's task_mutation_requests_pending_task_operation_idx) -- two callers can't each hold
			// their own pending "submit" on the SAME task simultaneously, by design (a task's lifecycle
			// is single global state). This test is isolating get()'s own (scope, key) addressing, not
			// that invariant, so it needs two different tasks to stay independent of it.
			store.put(record({ scope: "caller-a", key: "same-key", taskId: "task-1", createdAt: now, updatedAt: now }));
			store.put(
				record({ scope: "caller-b", key: "same-key", taskId: "task-2", receiptId: crypto.randomUUID(), createdAt: now, updatedAt: now }),
			);
			expect(store.get("caller-a", "same-key", now)?.scope).toBe("caller-a");
			expect(store.get("caller-b", "same-key", now)?.scope).toBe("caller-b");
		});

		it("findPending() finds a live pending record for (taskId, operation) and ignores other operations/tasks", () => {
			const store = make();
			const now = new Date().toISOString();
			const rec = record({ createdAt: now, updatedAt: now });
			store.put(rec);
			expect(store.findPending(rec.taskId!, rec.operation, now)?.receiptId).toBe(rec.receiptId);
			expect(store.findPending(rec.taskId!, "complete", now)).toBeUndefined();
			expect(store.findPending("other-task", rec.operation, now)).toBeUndefined();
		});

		it("findPending() ignores an already-expired pending record", () => {
			const store = make();
			const now = new Date().toISOString();
			const rec = record({ createdAt: now, updatedAt: now, expiresAt: now });
			store.put(rec);
			expect(store.findPending(rec.taskId!, rec.operation, new Date(Date.now() + 1).toISOString())).toBeUndefined();
		});

		it("put() of a second pending record for the same (taskId, operation) always throws TaskMutationPendingError, regardless of backing implementation", () => {
			const store = make();
			const now = new Date().toISOString();
			const first = record({ createdAt: now, updatedAt: now });
			store.put(first);
			const second = record({ key: "key-2", receiptId: crypto.randomUUID(), createdAt: now, updatedAt: now });
			expect(() => store.put(second)).toThrow(TaskMutationPendingError);
			// The thrown error identifies the ORIGINAL still-pending receipt, not the rejected one --
			// this is the exact property a caller (tasks.submit's own retry guidance) depends on.
			try {
				store.put(second);
				throw new Error("expected put() to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(TaskMutationPendingError);
				expect((error as TaskMutationPendingError).receiptId).toBe(first.receiptId);
			}
		});

		it("put() for a different operation on the same task, or the same operation on a different task, never collides", () => {
			const store = make();
			const now = new Date().toISOString();
			store.put(record({ createdAt: now, updatedAt: now }));
			expect(() =>
				store.put(record({ key: "key-2", receiptId: crypto.randomUUID(), operation: "complete", createdAt: now, updatedAt: now })),
			).not.toThrow();
			expect(() =>
				store.put(record({ key: "key-3", receiptId: crypto.randomUUID(), taskId: "task-2", createdAt: now, updatedAt: now })),
			).not.toThrow();
		});

		// Used to be a documented DIVERGENCE (InMemory silently overwrote a genuine duplicate
		// (scope, key) instead of rejecting it like SQLite's own PRIMARY KEY does) -- fixed in
		// InMemoryTaskMutationRequestStore.put(), now a real shared assertion both backends satisfy
		// identically. Every write through the real Tasks service already dedupes by requestHash
		// before ever calling put() a second time for the same (scope, key) (see task-service.ts's
		// prepareMutation()), so this path is never exercised in production today -- this only guards
		// a caller that talks to the store interface directly.
		it("put() of a genuine duplicate (scope, key) with a different taskId/operation always throws, regardless of backing implementation", () => {
			const store = make();
			const now = new Date().toISOString();
			const rec = record({ createdAt: now, updatedAt: now });
			store.put(rec);
			const clashing = record({ receiptId: crypto.randomUUID(), taskId: "task-99", operation: "cancel", createdAt: now, updatedAt: now });
			expect(() => store.put(clashing)).toThrow();
		});

		it("complete() transitions a pending record to completed and attaches the response", () => {
			const store = make();
			const now = new Date().toISOString();
			const rec = record({ createdAt: now, updatedAt: now });
			store.put(rec);
			const completedAt = new Date(Date.now() + 1).toISOString();
			store.complete(rec.scope, rec.key, JSON.stringify({ ok: true }), completedAt);
			const after = store.get(rec.scope, rec.key, completedAt);
			expect(after).toMatchObject({ state: "completed", responseJson: JSON.stringify({ ok: true }), updatedAt: completedAt });
		});

		it("complete() on a receipt that was never put() always throws, regardless of backing implementation", () => {
			const store = make();
			expect(() => store.complete("anonymous", "never-existed", "{}", new Date().toISOString())).toThrow();
		});

		it("a completed record no longer counts as pending for findPending()", () => {
			const store = make();
			const now = new Date().toISOString();
			const rec = record({ createdAt: now, updatedAt: now });
			store.put(rec);
			store.complete(rec.scope, rec.key, "{}", now);
			expect(store.findPending(rec.taskId!, rec.operation, now)).toBeUndefined();
		});

		it("once completed, a same (taskId, operation) pair can accept a brand new pending record", () => {
			const store = make();
			const now = new Date().toISOString();
			const first = record({ createdAt: now, updatedAt: now });
			store.put(first);
			store.complete(first.scope, first.key, "{}", now);
			const second = record({ key: "key-2", receiptId: crypto.randomUUID(), createdAt: now, updatedAt: now });
			expect(() => store.put(second)).not.toThrow();
		});

		it("prune() removes only records whose expiry has actually passed, leaving live ones untouched", () => {
			const store = make();
			const now = new Date().toISOString();
			const expired = record({ key: "expired", createdAt: now, updatedAt: now, expiresAt: now });
			const live = record({
				key: "live",
				receiptId: crypto.randomUUID(),
				taskId: "task-2",
				createdAt: now,
				updatedAt: now,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			});
			store.put(expired);
			store.put(live);
			const removed = store.prune(new Date(Date.now() + 1).toISOString());
			expect(removed).toBe(1);
			expect(store.get(expired.scope, expired.key, new Date(Date.now() + 1).toISOString())).toBeUndefined();
			expect(store.get(live.scope, live.key, new Date(Date.now() + 1).toISOString())).toEqual(live);
		});
	});
}
