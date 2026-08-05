/**
 * Walking-skeleton test for the Stricli-based replacement of runGraphProjectionCli's
 * hand-rolled flag-parsing loop. Same external contract as the original (args, client) =>
 * Promise<string> -- test/cli-parity.test.ts imports this same function and must keep working
 * unchanged.
 */
import { describe, expect, it } from "bun:test";
import { runGraphProjectionCli } from "../src/cli/graph-projection-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("runGraphProjectionCli (Stricli-backed)", () => {
	it("apply: parses --batch-json and calls graph_projection.apply with the decoded object", async () => {
		const client = new FakeClient({
			producerId: "p1",
			batchId: "b1",
			sequence: 1,
			artifactsUpserted: 0,
			artifactsCreated: 0,
			edgesUpserted: 0,
			alreadyApplied: false,
		});
		const output = await runGraphProjectionCli(
			[
				"apply",
				"--batch-json",
				'{"schema_version":"papyrus.graph-projection/v1","producer_id":"p1","batch_id":"b1","sequence":1,"artifacts":[],"edges":[]}',
				"--json",
			],
			client,
		);
		expect(client.calls).toEqual([
			{
				operation: "graph_projection.apply",
				input: { schema_version: "papyrus.graph-projection/v1", producer_id: "p1", batch_id: "b1", sequence: 1, artifacts: [], edges: [] },
			},
		]);
		expect(JSON.parse(output)).toEqual({
			producerId: "p1",
			batchId: "b1",
			sequence: 1,
			artifactsUpserted: 0,
			artifactsCreated: 0,
			edgesUpserted: 0,
			alreadyApplied: false,
		});
	});

	it("apply: rejects a --batch-json value that isn't a JSON object", async () => {
		const client = new FakeClient({});
		await expect(runGraphProjectionCli(["apply", "--batch-json", "[1,2,3]"], client)).rejects.toThrow();
	});

	it("apply: rejects when --batch-json is missing", async () => {
		const client = new FakeClient({});
		await expect(runGraphProjectionCli(["apply"], client)).rejects.toThrow();
	});

	it("checkpoint: parses --producer-id and calls graph_projection.checkpoint", async () => {
		const client = new FakeClient(null);
		const output = await runGraphProjectionCli(["checkpoint", "--producer-id", "p1", "--json"], client);
		expect(client.calls).toEqual([{ operation: "graph_projection.checkpoint", input: { producer_id: "p1" } }]);
		expect(output).toBe("null");
	});

	it("checkpoint: renders a human message for a null result without --json", async () => {
		const client = new FakeClient(null);
		const output = await runGraphProjectionCli(["checkpoint", "--producer-id", "p1"], client);
		expect(output).toBe('No projection checkpoint for producer "p1".');
	});

	it("checkpoint: pretty-prints a non-null result without --json", async () => {
		const client = new FakeClient({ sequence: 3 });
		const output = await runGraphProjectionCli(["checkpoint", "--producer-id", "p1"], client);
		expect(output).toBe(JSON.stringify({ sequence: 3 }, null, 2));
	});

	it("checkpoint: rejects when --producer-id is missing", async () => {
		const client = new FakeClient(null);
		await expect(runGraphProjectionCli(["checkpoint"], client)).rejects.toThrow();
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient(null);
		await expect(runGraphProjectionCli(["bogus"], client)).rejects.toThrow();
	});
});
