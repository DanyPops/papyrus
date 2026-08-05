import { describe, expect, it } from "bun:test";
import { runMigrationCli } from "../src/cli/migration-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("runMigrationCli (Stricli-backed)", () => {
	it("schema: calls system.migrate and reports applied migrations", async () => {
		const client = new FakeClient({ from: 1, to: 2, applied: ["x", "y"] });
		const output = await runMigrationCli(["schema"], client);
		expect(client.calls).toEqual([{ operation: "system.migrate", input: {} }]);
		expect(output).toBe("Migrated schema 1 → 2: x, y");
	});

	it("schema: reports already-current when nothing applied", async () => {
		const client = new FakeClient({ from: 2, to: 2, applied: [] });
		const output = await runMigrationCli(["schema"], client);
		expect(output).toBe("Schema already current at version 2.");
	});

	it("schema: --json returns the raw result", async () => {
		const client = new FakeClient({ from: 1, to: 2, applied: ["x"] });
		const output = await runMigrationCli(["schema", "--json"], client);
		expect(JSON.parse(output)).toEqual({ from: 1, to: 2, applied: ["x"] });
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runMigrationCli(["bogus"], client)).rejects.toThrow();
	});
});
