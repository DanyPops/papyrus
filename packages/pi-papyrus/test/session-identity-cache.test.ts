import { describe, expect, it } from "bun:test";
import { cacheSessionSecret, forgetSessionSecret, sessionSecretField } from "../extension/src/session-identity.ts";

describe("extension session-identity cache", () => {
	it("returns an empty object (no session_secret field at all) for an undefined or never-cached sessionId", () => {
		expect(sessionSecretField(undefined)).toEqual({});
		expect(sessionSecretField("never-cached")).toEqual({});
	});

	it("returns the cached secret for exactly the sessionId it was cached under, not any other", () => {
		cacheSessionSecret("session-a", "secret-a");
		cacheSessionSecret("session-b", "secret-b");
		expect(sessionSecretField("session-a")).toEqual({ session_secret: "secret-a" });
		expect(sessionSecretField("session-b")).toEqual({ session_secret: "secret-b" });
		expect(sessionSecretField("session-c")).toEqual({});
	});

	it("forgetting a sessionId's secret makes it fall back to empty again", () => {
		cacheSessionSecret("session-x", "secret-x");
		expect(sessionSecretField("session-x")).toEqual({ session_secret: "secret-x" });
		forgetSessionSecret("session-x");
		expect(sessionSecretField("session-x")).toEqual({});
	});

	it("re-caching a sessionId (rotation) overwrites the previous secret", () => {
		cacheSessionSecret("session-rotate", "first");
		cacheSessionSecret("session-rotate", "second");
		expect(sessionSecretField("session-rotate")).toEqual({ session_secret: "second" });
	});
});
