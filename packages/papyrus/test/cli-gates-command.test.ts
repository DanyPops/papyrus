import { describe, expect, it } from "bun:test";
import { runGatesCli } from "../src/cli/gates-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("runGatesCli (Stricli-backed)", () => {
	it("run: calls gates.run with the given id and renders each gate's pass/fail line", async () => {
		const client = new FakeClient([
			{ passed: true, gate: { type: "command", target: "bun test" }, output: "ok" },
			{ passed: false, gate: { type: "checklist", target: "x" }, output: "missing evidence" },
		]);
		const output = await runGatesCli(["run", "a1"], client);
		expect(client.calls).toEqual([{ operation: "gates.run", input: { id: "a1" } }]);
		expect(output).toBe("✓ command: bun test — ok\n✗ checklist: x — missing evidence");
	});

	it("run: renders a no-gates message when there are none configured", async () => {
		const client = new FakeClient([]);
		const output = await runGatesCli(["run", "a1"], client);
		expect(output).toBe("No gates configured.");
	});

	it("run: --json returns the raw JSON array", async () => {
		const client = new FakeClient([{ passed: true, gate: { type: "command", target: "x" }, output: "ok" }]);
		const output = await runGatesCli(["run", "a1", "--json"], client);
		expect(JSON.parse(output)).toEqual([{ passed: true, gate: { type: "command", target: "x" }, output: "ok" }]);
	});

	it("rejects when the id positional is missing", async () => {
		const client = new FakeClient([]);
		await expect(runGatesCli(["run"], client)).rejects.toThrow();
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient([]);
		await expect(runGatesCli(["bogus", "a1"], client)).rejects.toThrow();
	});
});
