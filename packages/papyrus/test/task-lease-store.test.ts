import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { TASK_LEASE_MAX_TTL_MS, TASK_LEASE_MIN_TTL_MS, TASK_LEASE_OWNER_MAX_LENGTH } from "../src/constants.ts";
import { openDb } from "../src/db.ts";
import { SQLiteTaskLeaseStore } from "../src/stores/sqlite-task-lease-store.ts";
import { InMemoryTaskLeaseStore, type TaskLeaseStore } from "../src/stores/task-lease-store.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

interface LeaseFixture {
	store: TaskLeaseStore;
	backdate: (taskId: string, expiresAt: string) => void;
	/** A real, persisted task id -- task_leases.task_id references artifacts(id) in SQLite. */
	taskId: (label: string) => string;
}

function sqliteFixture(): LeaseFixture {
	const dir = tempDir("papyrus-task-lease-");
	const db = openDb(join(dir, "papyrus.db"));
	const artifacts = new SQLiteArtifactStore(db);
	const ids = new Map<string, string>();
	return {
		store: new SQLiteTaskLeaseStore(db),
		backdate: (taskId, expiresAt) => {
			db.prepare("UPDATE task_leases SET lease_expires_at = ? WHERE task_id = ?").run(expiresAt, taskId);
		},
		taskId: (label) => {
			const existing = ids.get(label);
			if (existing) return existing;
			const created = artifacts.create({ kind: "task", status: "todo", title: label }).id;
			ids.set(label, created);
			return created;
		},
	};
}

function inMemoryFixture(): LeaseFixture {
	const store = new InMemoryTaskLeaseStore();
	return {
		store,
		backdate: (taskId, expiresAt) => {
			const leases = (store as unknown as { leases: Map<string, { leaseExpiresAt: string }> }).leases;
			const entry = leases.get(taskId);
			if (entry) entry.leaseExpiresAt = expiresAt;
		},
		// No FK to satisfy in-memory -- the label itself is a fine stand-in id.
		taskId: (label) => label,
	};
}

for (const [name, makeFixture] of [
	["SQLiteTaskLeaseStore", sqliteFixture],
	["InMemoryTaskLeaseStore", inMemoryFixture],
] as const) {
	describe(`TaskLeaseStore — ${name}`, () => {
		it("claims a fresh task lease with a generated token and an expiry ttlMs out", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			const before = Date.now();
			const lease = store.claim(t1, "worker-a", 60_000);
			expect(lease.taskId).toBe(t1);
			expect(lease.owner).toBe("worker-a");
			expect(lease.token.length).toBeGreaterThan(0);
			expect(new Date(lease.leaseExpiresAt).getTime()).toBeGreaterThanOrEqual(before + 60_000);
			expect(lease.heartbeatAt).toBeUndefined();
		});

		it("re-claiming as the SAME owner renews in place: same token, same claimedAt, extended expiry", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			const first = store.claim(t1, "worker-a", 1_000);
			const second = store.claim(t1, "worker-a", 60_000);
			expect(second.token).toBe(first.token);
			expect(second.claimedAt).toBe(first.claimedAt);
			expect(new Date(second.leaseExpiresAt).getTime()).toBeGreaterThan(new Date(first.leaseExpiresAt).getTime());
		});

		it("refuses to claim a task already live-leased by a DIFFERENT owner", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			store.claim(t1, "worker-a", 60_000);
			expect(() => store.claim(t1, "worker-b", 60_000)).toThrow(/already leased by "worker-a"/);
		});

		it("allows a different owner to claim once the prior lease has expired", () => {
			const { store, backdate, taskId } = makeFixture();
			const t1 = taskId("t1");
			store.claim(t1, "worker-a", 60_000);
			backdate(t1, new Date(Date.now() - 1).toISOString());
			const claimed = store.claim(t1, "worker-b", 60_000);
			expect(claimed.owner).toBe("worker-b");
		});

		it("heartbeat extends a live lease's expiry and stamps heartbeatAt, keeping the same token", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			const claimed = store.claim(t1, "worker-a", 60_000);
			const renewed = store.heartbeat(t1, "worker-a", claimed.token, 120_000);
			expect(renewed.token).toBe(claimed.token);
			expect(renewed.heartbeatAt).toBeDefined();
			expect(new Date(renewed.leaseExpiresAt).getTime()).toBeGreaterThan(new Date(claimed.leaseExpiresAt).getTime());
		});

		it("heartbeat refuses a mismatched owner or a mismatched token", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			const claimed = store.claim(t1, "worker-a", 60_000);
			expect(() => store.heartbeat(t1, "worker-b", claimed.token)).toThrow(/different owner\/token/);
			expect(() => store.heartbeat(t1, "worker-a", "not-the-real-token")).toThrow(/different owner\/token/);
		});

		it("heartbeat refuses when there is no lease at all", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			expect(() => store.heartbeat(t1, "worker-a", "any-token")).toThrow(/no live lease/);
		});

		it("heartbeat refuses to resurrect an expired lease -- a stale renewal must not silently revive a claim someone else may have already taken", () => {
			const { store, backdate, taskId } = makeFixture();
			const t1 = taskId("t1");
			const claimed = store.claim(t1, "worker-a", 60_000);
			backdate(t1, new Date(Date.now() - 1).toISOString());
			expect(() => store.heartbeat(t1, "worker-a", claimed.token)).toThrow(/no live lease/);
		});

		it("release removes a lease the caller genuinely holds, returning released: true", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			const claimed = store.claim(t1, "worker-a", 60_000);
			expect(store.release(t1, "worker-a", claimed.token)).toEqual({ released: true });
			expect(store.get(t1)).toBeUndefined();
		});

		it("release on a task with no lease is an idempotent no-op, not an error", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			expect(store.release(t1, "worker-a", "whatever")).toEqual({ released: false });
		});

		it("release refuses to remove a LIVE lease held by a different owner/token -- not a benign no-op", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			const claimed = store.claim(t1, "worker-a", 60_000);
			expect(() => store.release(t1, "worker-b", claimed.token)).toThrow(/different owner\/token/);
			expect(() => store.release(t1, "worker-a", "forged-token")).toThrow(/different owner\/token/);
			expect(store.get(t1)).toEqual(claimed);
		});

		it("release on an EXPIRED lease is a no-op even with the wrong owner/token -- expired reads as absent", () => {
			const { store, backdate, taskId } = makeFixture();
			const t1 = taskId("t1");
			store.claim(t1, "worker-a", 60_000);
			backdate(t1, new Date(Date.now() - 1).toISOString());
			expect(store.release(t1, "someone-else", "wrong-token")).toEqual({ released: false });
		});

		it("get returns undefined once a lease has expired, even before any reap sweep runs", () => {
			const { store, backdate, taskId } = makeFixture();
			const t1 = taskId("t1");
			store.claim(t1, "worker-a", 60_000);
			expect(store.get(t1)).toBeDefined();
			backdate(t1, new Date(Date.now() - 1).toISOString());
			expect(store.get(t1)).toBeUndefined();
		});

		it("reapExpired removes only rows strictly older than the cutoff, leaving live leases untouched", () => {
			const { store, backdate, taskId } = makeFixture();
			const expiredId = taskId("expired-1");
			const liveId = taskId("live-1");
			store.claim(expiredId, "worker-a", 60_000);
			store.claim(liveId, "worker-b", 60_000);
			backdate(expiredId, new Date(Date.now() - 1).toISOString());
			const cutoffNow = new Date().toISOString();
			expect(store.reapExpired(cutoffNow)).toBe(1);
			expect(store.get(liveId)).toBeDefined();
		});

		it("rejects an owner outside the length bound, and a ttlMs outside the min/max bound", () => {
			const { store, taskId } = makeFixture();
			const t1 = taskId("t1");
			expect(() => store.claim(t1, "", 60_000)).toThrow(/lease owner must be between/);
			expect(() => store.claim(t1, "x".repeat(TASK_LEASE_OWNER_MAX_LENGTH + 1), 60_000)).toThrow(/lease owner must be between/);
			expect(() => store.claim(t1, "worker-a", TASK_LEASE_MIN_TTL_MS - 1)).toThrow(/lease ttl_ms must be between/);
			expect(() => store.claim(t1, "worker-a", TASK_LEASE_MAX_TTL_MS + 1)).toThrow(/lease ttl_ms must be between/);
		});
	});
}
