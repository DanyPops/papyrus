import { describe, expect, it } from "bun:test";
import { SQLiteSessionIdentityStore } from "../src/adapters/sqlite-session-identity-store.ts";
import { SESSION_IDENTITY_MAX_ROWS } from "../src/constants.ts";
import { openDb } from "../src/db.ts";
import { SessionIdentity } from "../src/session-identity-service.ts";

/**
 * Real SQLite round-trip coverage, mirroring the pattern established by
 * sqlite-log-store.test.ts: the same SessionIdentity service, wired to the real adapter,
 * against a real (in-memory) SQLite connection -- not the daemon-kit primitive's own
 * in-memory-Map fixture (that lives in @danypops/daemon-kit's own test suite).
 */
describe("SQLiteSessionIdentityStore (via SessionIdentity)", () => {
	it("round-trips a registration through real SQLite: verifies true for the right session id and secret, false for any other combination", () => {
		const db = openDb(":memory:");
		const identity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
		const a = identity.register("session-a");
		const b = identity.register("session-b");

		// two different explicit session ids must return two different, non-cross-verifying results
		expect(a.sessionId).toBe("session-a");
		expect(b.sessionId).toBe("session-b");
		expect(a.secret).not.toBe(b.secret);
		expect(identity.verify("session-a", a.secret)).toBe(true);
		expect(identity.verify("session-b", b.secret)).toBe(true);
		expect(identity.verify("session-a", b.secret)).toBe(false);
		expect(identity.verify("session-b", a.secret)).toBe(false);
	});

	it("persists real rows queryable by the raw table, not just through the service", () => {
		const db = openDb(":memory:");
		const identity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
		identity.register("session-a");
		const row = db.prepare("SELECT session_id, secret_hash, registered_at, last_seen_at FROM session_identities WHERE session_id = ?").get("session-a") as
			| { session_id: string; secret_hash: string; registered_at: string; last_seen_at: string }
			| null;
		expect(row).not.toBeNull();
		expect(row!.secret_hash).toMatch(/^[a-f0-9]{64}$/);
		// the plaintext secret is never persisted, only its hash
		expect(row!.secret_hash).not.toBe(identity.register("session-a").secret);
	});

	it("re-registering rotates the secret in real storage, invalidating the old one", () => {
		const db = openDb(":memory:");
		const identity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
		const first = identity.register("session-a");
		expect(identity.verify("session-a", first.secret)).toBe(true);
		const second = identity.register("session-a");
		expect(identity.verify("session-a", first.secret)).toBe(false);
		expect(identity.verify("session-a", second.secret)).toBe(true);
	});

	it("release removes the real row, requiring the correct secret; a wrong secret is a real no-op", () => {
		const db = openDb(":memory:");
		const identity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
		const { sessionId, secret } = identity.register("session-a");

		expect(identity.release(sessionId, "wrong").released).toBe(false);
		expect(identity.isRegistered(sessionId)).toBe(true);

		expect(identity.release(sessionId, secret).released).toBe(true);
		expect(identity.isRegistered(sessionId)).toBe(false);
		expect(db.prepare("SELECT 1 FROM session_identities WHERE session_id = ?").get(sessionId)).toBeNull();
	});

	it("bounds real storage: registering beyond SESSION_IDENTITY_MAX_ROWS evicts the least-recently-seen row", () => {
		const db = openDb(":memory:");
		const identity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
		for (let index = 0; index < SESSION_IDENTITY_MAX_ROWS; index++) identity.register(`session-${index}`);
		expect((db.prepare("SELECT COUNT(*) AS count FROM session_identities").get() as { count: number }).count).toBe(SESSION_IDENTITY_MAX_ROWS);

		identity.register("session-overflow");
		const count = (db.prepare("SELECT COUNT(*) AS count FROM session_identities").get() as { count: number }).count;
		expect(count).toBe(SESSION_IDENTITY_MAX_ROWS);
		// the very first-registered (and therefore least-recently-seen) row is the one evicted
		expect(identity.isRegistered("session-0")).toBe(false);
		expect(identity.isRegistered("session-overflow")).toBe(true);
	});
});
