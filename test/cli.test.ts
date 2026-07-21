import { describe, expect, it } from "bun:test";
import { runDiscourseCli, runGraphCli, runMigrationCli, runNoteCli, runSkillCli, runTaskCli } from "../src/cli.ts";
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
		const client = new FakeClient({ from: 5, to: 6, applied: ["discourse-context-mesh"] });
		expect(await runMigrationCli(["schema", "--json"], client)).toBe(JSON.stringify({
			from: 5,
			to: 6,
			applied: ["discourse-context-mesh"],
		}));
		expect(client.calls).toEqual([{ operation: "system.migrate", input: {} }]);
	});
});

describe("Papyrus graph history CLI", () => {
	it("routes bounded who-did-what-when queries through the authenticated daemon with stable JSON", async () => {
		const page = { events: [{ id: 1, artifactId: "doc-1", occurredAt: "2026-01-01T00:00:00.000Z", type: "created", actor: "agent", source: "pi", schemaVersion: 1 }] };
		const client = new FakeClient(page);
		expect(await runGraphCli(["history", "--id", "doc-1", "--json"], client)).toBe(JSON.stringify(page));
		expect(client.calls).toEqual([{ operation: "graph.history", input: { id: "doc-1" } }]);
	});

	it("parses actor, session, and pagination flags, and renders human-readable output", async () => {
		const page = { events: [] as unknown[] };
		const client = new FakeClient(page);
		expect(await runGraphCli(["history", "--actor", "agent-a", "--session-id", "ses-1", "--limit", "10", "--cursor", "3", "--direction", "asc"], client)).toBe("No recorded events.");
		expect(client.calls).toEqual([{
			operation: "graph.history",
			input: { actor: "agent-a", session_id: "ses-1", limit: 10, cursor: 3, direction: "asc" },
		}]);
	});

	it("requires the history subcommand", async () => {
		const client = new FakeClient({});
		await expect(runGraphCli([], client)).rejects.toThrow("graph requires `history`");
	});
});

describe("Papyrus Discourse store CLI", () => {
	it("routes bounded store operations through the authenticated daemon with stable JSON", async () => {
		const result = { items: [], truncated: false, completeness: "complete" };
		const client = new FakeClient(result);
		expect(await runDiscourseCli([
			"store", "read_thread", "--store-id", "team-forum",
			"--input-json", '{"forumId":"engineering","topicId":"reviews","threadId":"mesh","limit":10}',
			"--json",
		], client)).toBe(JSON.stringify(result));
		expect(client.calls).toEqual([{
			operation: "discourse.store",
			input: {
				action: "read_thread", store_id: "team-forum", forumId: "engineering",
				topicId: "reviews", threadId: "mesh", limit: 10,
			},
		}]);
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

describe("Papyrus Notes CLI", () => {
	it("captures deferred intent through the authenticated daemon with stable JSON", async () => {
		const note = { id: "note-1", title: "Review later", status: "draft" };
		const client = new FakeClient(note);
		expect(await runNoteCli(["capture", "Review later", "--json"], client)).toBe(JSON.stringify(note));
		expect(client.calls).toEqual([{
			operation: "notes.capture",
			input: { body: "Review later", project_root: PROJECT_ROOT, actor: "human", source: "cli" },
		}]);
	});

	it("lists, consumes, promotes, and archives project Notes", async () => {
		const listed = new FakeClient([{ id: "note-1", title: "Review later", status: "draft" }]);
		expect(await runNoteCli(["list", "--limit", "10"], listed)).toContain("note-1 Review later");
		expect(listed.calls).toEqual([{ operation: "notes.list", input: { project_root: PROJECT_ROOT, limit: 10 } }]);

		const consumed = new FakeClient({ id: "note-1", title: "Review later", status: "active" });
		await runNoteCli(["consume", "note-1"], consumed);
		expect(consumed.calls).toEqual([{ operation: "notes.consume", input: { id: "note-1", project_root: PROJECT_ROOT, actor: "agent", source: "cli" } }]);

		const promoted = new FakeClient({ id: "note-1", title: "Review later", status: "archived" });
		await runNoteCli(["promote", "note-1", "task-1", "--reason", "Task created"], promoted);
		expect(promoted.calls).toEqual([{ operation: "notes.promote", input: { id: "note-1", target_id: "task-1", project_root: PROJECT_ROOT, actor: "agent", source: "cli", reason: "Task created" } }]);

		const archived = new FakeClient({ id: "note-2", title: "Skip", status: "archived" });
		await runNoteCli(["archive", "note-2", "declined", "--reason", "Not useful"], archived);
		expect(archived.calls).toEqual([{ operation: "notes.archive", input: { id: "note-2", disposition: "declined", project_root: PROJECT_ROOT, actor: "human", source: "cli", reason: "Not useful" } }]);
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

	it("omits session_id by default, preserving today's shared global Focus behavior", async () => {
		const client = new FakeClient(null);
		await runTaskCli(["active"], client);
		expect(client.calls).toEqual([{ operation: "tasks.active", input: { project_root: PROJECT_ROOT } }]);
	});

	it("threads --session-id through Focus-related task operations", async () => {
		const active = new FakeClient({ id: "task", title: "Task", status: "in-progress" });
		await runTaskCli(["active", "--session-id", "ses-alice"], active);
		expect(active.calls).toEqual([{ operation: "tasks.active", input: { project_root: PROJECT_ROOT, session_id: "ses-alice" } }]);

		const focus = new FakeClient({ id: "task", title: "Task", status: "in-progress" });
		await runTaskCli(["focus", "task", "--session-id", "ses-alice"], focus);
		expect(focus.calls).toEqual([{ operation: "tasks.focus", input: { id: "task", actor: "user", source: "cli", session_id: "ses-alice" } }]);

		const pause = new FakeClient({ artifact: { id: "task", title: "Task", status: "in-progress" }, status: "paused" });
		await runTaskCli(["pause", "--session-id", "ses-alice"], pause);
		expect(pause.calls).toEqual([{ operation: "tasks.pause", input: { actor: "user", source: "cli", session_id: "ses-alice" } }]);
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

		const recoveryClient = new FakeClient({ id: "task", title: "Recovered", status: "todo" });
		expect(await runTaskCli(["update", "task", "--status", "todo", "--reason", "legacy default"], recoveryClient)).toBe("Updated: task Recovered");
		expect(recoveryClient.calls).toEqual([{
			operation: "tasks.update",
			input: { id: "task", status: "todo", reason: "legacy default", actor: "user", source: "cli" },
		}]);

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
