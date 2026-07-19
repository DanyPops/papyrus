import { describe, expect, it } from "bun:test";
import { runMigrationCli, runTaskCli } from "../src/cli.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("Papyrus migration CLI", () => {
	it("routes the explicit task lifecycle migration through the daemon", async () => {
		const client = new FakeClient({ from: 1, to: 2, applied: ["task-lifecycle-and-focus"] });
		expect(await runMigrationCli(["task-lifecycle", "--json"], client)).toBe(JSON.stringify({
			from: 1,
			to: 2,
			applied: ["task-lifecycle-and-focus"],
		}));
		expect(client.calls).toEqual([{ operation: "system.migrate", input: {} }]);
	});
});

describe("Papyrus task CLI", () => {
	it("completes through the daemon client and names the newly focused successor", async () => {
		const client = new FakeClient({
			artifact: { id: "root", title: "Root", status: "done" },
			gates: [],
			completed: true,
			focused: { id: "left", title: "Left", status: "todo" },
			checklist: [],
			blocked: [],
		});

		const output = await runTaskCli(["complete", "root"], client);

		expect(client.calls).toEqual([{ operation: "tasks.complete", input: { id: "root" } }]);
		expect(output).toContain("Completed: root Root");
		expect(output).toContain("Active: left Left");
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
		const dependencyClient = new FakeClient({ id: "task", title: "Task", status: "todo" });
		await runTaskCli(["depend", "task", "prerequisite", "--json"], dependencyClient);
		expect(dependencyClient.calls).toEqual([{
			operation: "tasks.depend",
			input: { id: "task", dependency_id: "prerequisite" },
		}]);

		const startClient = new FakeClient({ id: "task", title: "Task", status: "in-progress" });
		expect(await runTaskCli(["start", "task"], startClient)).toBe("Started: task Task");
		expect(startClient.calls).toEqual([{ operation: "tasks.start", input: { id: "task" } }]);

		const focusClient = new FakeClient({ id: "task", title: "Task", status: "todo" });
		expect(await runTaskCli(["focus", "task"], focusClient)).toBe("Active: task Task");
		expect(focusClient.calls).toEqual([{ operation: "tasks.focus", input: { id: "task" } }]);

		const activeClient = new FakeClient({ id: "task", title: "Task", status: "todo" });
		expect(await runTaskCli(["active", "--json"], activeClient)).toBe(JSON.stringify({ id: "task", title: "Task", status: "todo" }));
		expect(activeClient.calls).toEqual([{ operation: "tasks.active", input: {} }]);

		for (const action of ["submit", "reject", "retry", "cancel"] as const) {
			const lifecycleClient = new FakeClient({ id: "task", title: "Task", status: "review" });
			await runTaskCli([action, "task", "--json"], lifecycleClient);
			expect(lifecycleClient.calls).toEqual([{ operation: `tasks.${action}`, input: { id: "task" } }]);
		}
	});
});
