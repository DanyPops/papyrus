import { describe, expect, it } from "bun:test";
import { runTaskCli } from "../src/cli.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("Papyrus task CLI", () => {
	it("completes through the daemon client and names newly started successors", async () => {
		const client = new FakeClient({
			artifact: { id: "root", title: "Root", status: "done" },
			gates: [],
			completed: true,
			started: [
				{ id: "left", title: "Left", status: "active" },
				{ id: "right", title: "Right", status: "active" },
			],
			blocked: [],
		});

		const output = await runTaskCli(["complete", "root"], client);

		expect(client.calls).toEqual([{ operation: "tasks.complete", input: { id: "root" } }]);
		expect(output).toContain("Completed: root Root");
		expect(output).toContain("Started: left Left, right Right");
	});

	it("prints stable JSON for machine consumers", async () => {
		const result = {
			layers: [["root"], ["left", "right"]],
			cycleIds: [],
			nodes: [{ id: "root", title: "Root", status: "done", state: "done", layer: 0, prerequisiteIds: [], successorIds: ["left", "right"] }],
		};
		const client = new FakeClient(result);

		expect(await runTaskCli(["plan", "--json"], client)).toBe(JSON.stringify(result));
		expect(client.calls).toEqual([{ operation: "tasks.plan", input: {} }]);
	});

	it("routes dependency and start mutations through authenticated task operations", async () => {
		const dependencyClient = new FakeClient({ id: "task", title: "Task", status: "pending" });
		await runTaskCli(["depend", "task", "prerequisite", "--json"], dependencyClient);
		expect(dependencyClient.calls).toEqual([{
			operation: "tasks.depend",
			input: { id: "task", dependency_id: "prerequisite" },
		}]);

		const startClient = new FakeClient({ id: "task", title: "Task", status: "active" });
		expect(await runTaskCli(["start", "task"], startClient)).toBe("Started: task Task");
		expect(startClient.calls).toEqual([{ operation: "tasks.start", input: { id: "task" } }]);
	});
});
