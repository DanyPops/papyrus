import { describe, expect, it } from "bun:test";
import { SQLiteSessionIdentityStore } from "../src/adapters/sqlite-session-identity-store.ts";
import { openDb } from "../src/db.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { sessionIdentityOperations, SESSION_IDENTITY_OPERATION_NAMES } from "../src/modules/session-identity.ts";
import { SessionIdentity } from "../src/session-identity-service.ts";

function fixture() {
	const db = openDb(":memory:");
	const sessionIdentity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
	const registry = new OperationRegistry();
	registry.registerAll(sessionIdentityOperations(sessionIdentity));
	return { registry, sessionIdentity };
}

describe("session-identity module: registration and operation input parsing", () => {
	it("registers exactly the session.* operations EXPECTED_OPERATION_NAMES declares, no more, no fewer", () => {
		const { registry } = fixture();
		expect(registry.list().filter((name) => name.startsWith("session."))).toEqual([...SESSION_IDENTITY_OPERATION_NAMES].sort());
	});

	it("session.register requires session_id and returns a real sessionId/secret pair", () => {
		const { registry } = fixture();
		expect(() => registry.get("session.register")!.execute({})).toThrow("session_id is required");
		const result = registry.get("session.register")!.execute({ session_id: "session-a" }) as { sessionId: string; secret: string };
		expect(result.sessionId).toBe("session-a");
		expect(result.secret).toMatch(/^[a-f0-9]{64}$/);
	});

	it("session.release requires session_id, accepts an optional session_secret, and reports whether it actually released", () => {
		const { registry } = fixture();
		const { secret } = registry.get("session.register")!.execute({ session_id: "session-a" }) as { sessionId: string; secret: string };
		expect(() => registry.get("session.release")!.execute({})).toThrow("session_id is required");

		const wrongSecret = registry.get("session.release")!.execute({ session_id: "session-a", session_secret: "wrong" }) as { released: boolean };
		expect(wrongSecret.released).toBe(false);

		const rightSecret = registry.get("session.release")!.execute({ session_id: "session-a", session_secret: secret }) as { released: boolean };
		expect(rightSecret.released).toBe(true);
	});
});
