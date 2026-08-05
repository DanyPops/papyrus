import { describe, expect, it } from "bun:test";
import { runSessionIdentityCli } from "../src/cli/session-identity-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("runSessionIdentityCli (Stricli-backed)", () => {
	it("register: calls session.register with --session-id", async () => {
		const client = new FakeClient({ sessionId: "s1", secret: "abc" });
		const output = await runSessionIdentityCli(["register", "--session-id", "s1"], client);
		expect(client.calls).toEqual([{ operation: "session.register", input: { session_id: "s1" } }]);
		expect(output).toBe(JSON.stringify({ sessionId: "s1", secret: "abc" }, null, 2));
	});

	it("register: --json returns compact JSON", async () => {
		const client = new FakeClient({ sessionId: "s1", secret: "abc" });
		const output = await runSessionIdentityCli(["register", "--session-id", "s1", "--json"], client);
		expect(output).toBe(JSON.stringify({ sessionId: "s1", secret: "abc" }));
	});

	it("register: rejects when --session-id is missing", async () => {
		const client = new FakeClient({});
		await expect(runSessionIdentityCli(["register"], client)).rejects.toThrow();
	});

	it("release: calls session.release with --session-id and --session-secret when given", async () => {
		const client = new FakeClient({ released: true });
		const output = await runSessionIdentityCli(["release", "--session-id", "s1", "--session-secret", "abc"], client);
		expect(client.calls).toEqual([{ operation: "session.release", input: { session_id: "s1", session_secret: "abc" } }]);
		expect(output).toBe(JSON.stringify({ released: true }, null, 2));
	});

	it("release: omits session_secret entirely when not given", async () => {
		const client = new FakeClient({ released: true });
		await runSessionIdentityCli(["release", "--session-id", "s1"], client);
		expect(client.calls).toEqual([{ operation: "session.release", input: { session_id: "s1" } }]);
	});

	it("release: rejects when --session-id is missing", async () => {
		const client = new FakeClient({});
		await expect(runSessionIdentityCli(["release"], client)).rejects.toThrow();
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runSessionIdentityCli(["bogus"], client)).rejects.toThrow();
	});
});
