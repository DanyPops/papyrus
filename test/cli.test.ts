import { describe, expect, it } from "bun:test";
import { runMigrationCli, runSkillCli, runTaskCli } from "../src/cli.ts";
import type { OperationName } from "../src/service.ts";

const PROJECT_ROOT = process.cwd();

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("Papyrus migration CLI", () => {
	it("routes the explicit task focus migration through the daemon", async () => {
		const client = new FakeClient({ from: 4, to: 5, applied: ["task-focus-continuation"] });
		expect(await runMigrationCli(["task-focus", "--json"], client)).toBe(JSON.stringify({
			from: 4,
			to: 5,
			applied: ["task-focus-continuation"],
		}));
		expect(client.calls).toEqual([{ operation: "system.migrate", input: {} }]);
	});
});

describe("Papyrus Skill CLI", () => {
	it("runs a workflow through the authenticated daemon client with stable JSON", async () => {
		const result = {
			runId: "run-001",
			created: { tasks: ["run-001-task"], rules: [], docs: [] },
			rootTaskIds: ["run-001-task"],
		};
		const client = new FakeClient(result);
		expect(await runSkillCli([
			"run", "skill-1", "--arguments-json", '{"project":"Papyrus"}', "--run-id", "run-001", "--json",
		], client)).toBe(JSON.stringify(result));
		expect(client.calls).toEqual([{
			operation: "skills.run",
			input: { id: "skill-1", arguments: { project: "Papyrus" }, project_root: PROJECT_ROOT, run_id: "run-001" },
		}]);
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

		expect(client.calls).toEqual([{ operation: "tasks.complete", input: { id: "root", actor: "user", source: "cli" } }]);
		expect(output).toContain("Completed: root Root");
		expect(output).toContain("Active: left Left");
	});

	it("reads bounded task history through the daemon", async () => {
		const page = { events: [{ occurredAt: "2026-01-01T00:00:00.000Z", type: "started", fromStatus: "todo", toStatus: "in-progress", actor: "agent", source: "pi-tool" }] };
		const client = new FakeClient(page);
		expect(await runTaskCli(["history", "task", "--json"], client)).toBe(JSON.stringify(page));
		expect(client.calls).toEqual([{ operation: "tasks.history", input: { id: "task", direction: "desc" } }]);
	});

	it("reads and persists project, focused-graph, and all-project scopes", async () => {
		const current = new FakeClient({ mode: "project", label: "papyrus", projectRoot: PROJECT_ROOT });
		expect(await runTaskCli(["scope"], current)).toBe("Task scope: papyrus");
		expect(current.calls).toEqual([{ operation: "tasks.scope", input: { project_root: PROJECT_ROOT } }]);
		const all = new FakeClient({ mode: "all", label: "All projects", projectRoot: PROJECT_ROOT });
		expect(await runTaskCli(["scope", "all", "--json"], all)).toContain('"mode":"all"');
		expect(all.calls).toEqual([{ operation: "tasks.set_scope", input: { project_root: PROJECT_ROOT, scope: "all" } }]);
		const graph = new FakeClient({ mode: "graph", label: "papyrus · Epic", projectRoot: PROJECT_ROOT, rootTaskId: "epic" });
		await runTaskCli(["scope", "graph", "epic"], graph);
		expect(graph.calls).toEqual([{ operation: "tasks.set_scope", input: { project_root: PROJECT_ROOT, scope: "graph", root_task_id: "epic" } }]);
	});

	it("prints stable JSON for machine consumers", async () => {
		const graph = { nodes: [{ dependencyIds: [], childIds: [] }], rootIds: ["root"] };
		const graphClient = new FakeClient(graph);
		expect(await runTaskCli(["graph", "--json"], graphClient)).toBe(JSON.stringify(graph));
		expect(graphClient.calls).toEqual([{ operation: "tasks.graph", input: { limit: 1001, project_root: PROJECT_ROOT } }]);

		const result = {
			layers: [["root"], ["left", "right"]],
			cycleIds: [],
			nodes: [{ id: "root", title: "Root", status: "done", state: "done", layer: 0, prerequisiteIds: [], successorIds: ["left", "right"] }],
		};
		const client = new FakeClient(result);

		expect(await runTaskCli(["plan", "--json"], client)).toBe(JSON.stringify(result));
		expect(client.calls).toEqual([{ operation: "tasks.plan", input: { project_root: PROJECT_ROOT } }]);
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
		expect(startClient.calls).toEqual([{ operation: "tasks.start", input: { id: "task", actor: "user", source: "cli" } }]);

		const updateClient = new FakeClient({ id: "task", title: "Updated", status: "in-progress" });
		expect(await runTaskCli(["update", "task", "--title", "Updated", "--body", "New body"], updateClient)).toBe("Updated: task Updated");
		expect(updateClient.calls).toEqual([{ operation: "tasks.update", input: { id: "task", title: "Updated", body: "New body", actor: "user", source: "cli" } }]);

		const pauseClient = new FakeClient({ artifact: { id: "task", title: "Task", status: "in-progress" }, status: "paused" });
		expect(await runTaskCli(["pause"], pauseClient)).toBe("Focused (paused): task Task");
		expect(pauseClient.calls).toEqual([{ operation: "tasks.pause", input: { actor: "user", source: "cli" } }]);

		const clearClient = new FakeClient({ cleared: true });
		expect(await runTaskCli(["clear-focus"], clearClient)).toBe("Task focus cleared.");
		expect(clearClient.calls).toEqual([{ operation: "tasks.clear_focus", input: { actor: "user", source: "cli" } }]);

		const focusClient = new FakeClient({ id: "task", title: "Task", status: "todo" });
		expect(await runTaskCli(["focus", "task"], focusClient)).toBe("Active: task Task");
		expect(focusClient.calls).toEqual([{ operation: "tasks.focus", input: { id: "task", actor: "user", source: "cli" } }]);

		const activeClient = new FakeClient({ id: "task", title: "Task", status: "todo" });
		expect(await runTaskCli(["active", "--json"], activeClient)).toBe(JSON.stringify({ id: "task", title: "Task", status: "todo" }));
		expect(activeClient.calls).toEqual([{ operation: "tasks.active", input: { project_root: PROJECT_ROOT } }]);

		for (const action of ["submit", "reject", "retry", "cancel"] as const) {
			const lifecycleClient = new FakeClient({ id: "task", title: "Task", status: "review" });
			await runTaskCli([action, "task", "--json"], lifecycleClient);
			expect(lifecycleClient.calls).toEqual([{ operation: `tasks.${action}`, input: { id: "task", actor: "user", source: "cli" } }]);
		}
	});
});
