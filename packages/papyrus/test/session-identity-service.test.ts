import { describe, expect, it } from "bun:test";
import { SQLiteSessionIdentityStore } from "../src/adapters/sqlite-session-identity-store.ts";
import { openDb } from "../src/db.ts";
import { InvalidSessionSecretError, SessionIdentity } from "../src/session-identity-service.ts";

function fixture() {
	const db = openDb(":memory:");
	return new SessionIdentity(new SQLiteSessionIdentityStore(db));
}

describe("SessionIdentity.assertAuthorized — opt-in armor enforcement", () => {
	it("passes through silently when sessionId is undefined (the 'global' Task Focus scope, never armored)", () => {
		const identity = fixture();
		expect(() => identity.assertAuthorized(undefined, undefined)).not.toThrow();
		expect(() => identity.assertAuthorized(undefined, "any-secret")).not.toThrow();
	});

	it("passes through silently for a sessionId that was never registered, regardless of secret presented", () => {
		const identity = fixture();
		expect(() => identity.assertAuthorized("never-registered", undefined)).not.toThrow();
		expect(() => identity.assertAuthorized("never-registered", "guess")).not.toThrow();
	});

	it("requires the exact matching secret once a sessionId is registered, rejecting a missing or wrong one", () => {
		const identity = fixture();
		const { sessionId, secret } = identity.register("session-a");
		expect(() => identity.assertAuthorized(sessionId, undefined)).toThrow(InvalidSessionSecretError);
		expect(() => identity.assertAuthorized(sessionId, "wrong-secret")).toThrow(InvalidSessionSecretError);
		expect(() => identity.assertAuthorized(sessionId, secret)).not.toThrow();
	});

	it("two different registered sessions never authorize each other's secret", () => {
		const identity = fixture();
		const a = identity.register("session-a");
		const b = identity.register("session-b");
		expect(() => identity.assertAuthorized(a.sessionId, b.secret)).toThrow(InvalidSessionSecretError);
		expect(() => identity.assertAuthorized(b.sessionId, a.secret)).toThrow(InvalidSessionSecretError);
		expect(() => identity.assertAuthorized(a.sessionId, a.secret)).not.toThrow();
		expect(() => identity.assertAuthorized(b.sessionId, b.secret)).not.toThrow();
	});

	it("rotating a session's secret (re-registering) invalidates the previously authorized secret", () => {
		const identity = fixture();
		const first = identity.register("session-a");
		expect(() => identity.assertAuthorized("session-a", first.secret)).not.toThrow();
		const second = identity.register("session-a");
		expect(() => identity.assertAuthorized("session-a", first.secret)).toThrow(InvalidSessionSecretError);
		expect(() => identity.assertAuthorized("session-a", second.secret)).not.toThrow();
	});

	it("releasing a session removes its armor, returning it to unregistered/pass-through behavior", () => {
		const identity = fixture();
		const { sessionId, secret } = identity.register("session-a");
		identity.release(sessionId, secret);
		expect(() => identity.assertAuthorized(sessionId, undefined)).not.toThrow();
		expect(() => identity.assertAuthorized(sessionId, "anything")).not.toThrow();
	});
});
