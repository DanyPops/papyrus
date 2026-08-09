import { describe, expect, it } from "bun:test";
import { runTaskCli } from "../src/cli/task-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

const artifact = { id: "t1", alias: "t1-alias", title: "T", status: "todo", body: "some body" };

describe("runTaskCli (Stricli-backed)", () => {
	it("active: threads project_root and optional session_id, renders 'no active task'", async () => {
		const client = new FakeClient(null);
		const output = await runTaskCli(["active"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.active", input: { project_root: "/proj" } }]);
		expect(output).toBe("No active task.");
	});

	it("active: threads --session-id when given", async () => {
		const client = new FakeClient(artifact);
		await runTaskCli(["active", "--session-id", "s1"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.active", input: { project_root: "/proj", session_id: "s1" } }]);
	});

	it("focused: renders active/paused status", async () => {
		const client = new FakeClient({ artifact, status: "active" });
		const output = await runTaskCli(["focused"], client, "/proj");
		expect(output).toBe("Focused (active): t1-alias T");
	});

	it.each(["pause", "unpause"])("%s: threads session_id and session_secret", async (action) => {
		const client = new FakeClient({ artifact, status: action === "pause" ? "paused" : "active" });
		await runTaskCli([action, "--session-id", "s1", "--session-secret", "sec"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: `tasks.${action}` as OperationName, input: { actor: "user", source: "cli", session_id: "s1", session_secret: "sec" } },
		]);
	});

	it("clear-focus: renders cleared vs not-found distinctly", async () => {
		const cleared = new FakeClient({ cleared: true });
		expect(await runTaskCli(["clear-focus"], cleared, "/proj")).toBe("Task focus cleared.");
		const notCleared = new FakeClient({ cleared: false });
		expect(await runTaskCli(["clear-focus"], notCleared, "/proj")).toBe("No focused task.");
	});

	it("reap-stale-focus: reports the removed count", async () => {
		const client = new FakeClient({ removed: 3 });
		expect(await runTaskCli(["reap-stale-focus"], client, "/proj")).toBe("Reaped 3 stale Focus scope(s).");
	});

	it("claim: requires --owner, threads ttl-ms and note, and renders the reusable task name", async () => {
		const lease = { taskName: "ready-work", taskTitle: "Ready work", owner: "me", token: "tok", claimedAt: "c", leaseExpiresAt: "e" };
		const client = new FakeClient(lease);
		const output = await runTaskCli(["claim", "t1", "--owner", "me", "--ttl-ms", "1000", "--note", "n"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.claim", input: { id: "t1", owner: "me", ttl_ms: 1000, note: "n" } }]);
		expect(output).toContain("ready-work (Ready work)");
	});

	it("heartbeat-lease: requires --owner and --token", async () => {
		const lease = { taskName: "ready-work", taskTitle: "Ready work", owner: "me", token: "tok", claimedAt: "c", leaseExpiresAt: "e" };
		const client = new FakeClient(lease);
		const output = await runTaskCli(["heartbeat-lease", "t1", "--owner", "me", "--token", "tok"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "tasks.heartbeat_lease", input: { id: "t1", owner: "me", token: "tok", ttl_ms: undefined } },
		]);
		expect(output).toContain("ready-work (Ready work)");
	});

	it("release-lease: renders released vs no-lease distinctly", async () => {
		const released = new FakeClient({ released: true });
		expect(await runTaskCli(["release-lease", "t1", "--owner", "me", "--token", "tok"], released, "/proj")).toBe("Lease released.");
	});

	it("lease: renders the task name for a live lease or 'no live lease'", async () => {
		const live = new FakeClient({
			taskName: "ready-work",
			taskTitle: "Ready work",
			owner: "me",
			token: "tok",
			claimedAt: "c",
			leaseExpiresAt: "e",
		});
		expect(await runTaskCli(["lease", "ready-work"], live, "/proj")).toContain("ready-work (Ready work)");
		const missing = new FakeClient(null);
		expect(await runTaskCli(["lease", "t1"], missing, "/proj")).toBe("No live lease.");
	});

	it("reap-stale-leases: reports the removed count", async () => {
		const client = new FakeClient({ removed: 2 });
		expect(await runTaskCli(["reap-stale-leases"], client, "/proj")).toBe("Reaped 2 expired lease(s).");
	});

	it("event-feed: threads cursor/limit/event-types-json", async () => {
		const client = new FakeClient({ events: [] });
		await runTaskCli(["event-feed", "--cursor", "5", "--limit", "10", "--event-types-json", '["started"]'], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.event_feed", input: { cursor: 5, limit: 10, event_types: ["started"] } }]);
	});

	it("mutation-status: resolves a lifecycle receipt by retry key", async () => {
		const client = new FakeClient({ state: "completed", operation: "start", receiptId: "receipt-1" });
		const output = await runTaskCli(["mutation-status", "start-1"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.mutation_status", input: { idempotency_key: "start-1" } }]);
		expect(output).toContain("start: completed (receipt-1)");
	});

	it("create: threads every flag plus project_root/actor/source and optional session_id", async () => {
		const client = new FakeClient(artifact);
		await runTaskCli(
			[
				"create",
				"--title",
				"T",
				"--body",
				"B",
				"--status",
				"todo",
				"--labels-json",
				'["a"]',
				"--extra-json",
				'{"x":1}',
				"--gates-json",
				'[{"type":"command"}]',
				"--checklist-json",
				'{"c":1}',
				"--template-id",
				"tmpl",
				"--parent-id",
				"p1",
				"--depends-on-json",
				'["d1"]',
			],
			client,
			"/proj",
		);
		expect(client.calls).toEqual([
			{
				operation: "tasks.create",
				input: {
					title: "T",
					body: "B",
					status: "todo",
					labels: ["a"],
					extra: { x: 1 },
					gates: [{ type: "command" }],
					checklist: { c: 1 },
					template_id: "tmpl",
					parent_id: "p1",
					depends_on: ["d1"],
					project_root: "/proj",
					actor: "user",
					source: "cli",
				},
			},
		]);
	});

	it("create: rejects without --title", async () => {
		const client = new FakeClient(artifact);
		await expect(runTaskCli(["create"], client, "/proj")).rejects.toThrow();
	});

	it("list: threads status/text/limit/labels/scope/root-task-id/session-id", async () => {
		const client = new FakeClient([]);
		await runTaskCli(["list", "--status", "todo", "--scope", "graph", "--root-task-id", "r1"], client, "/proj");
		expect(client.calls).toEqual([
			{
				operation: "tasks.list",
				input: {
					status: "todo",
					text: undefined,
					limit: undefined,
					labels: undefined,
					project_root: "/proj",
					scope: "graph",
					root_task_id: "r1",
				},
			},
		]);
	});

	it("list: rejects an invalid --scope value", async () => {
		const client = new FakeClient([]);
		await expect(runTaskCli(["list", "--scope", "bogus"], client, "/proj")).rejects.toThrow();
	});

	it("show: renders label plus body", async () => {
		const client = new FakeClient(artifact);
		expect(await runTaskCli(["show", "t1"], client, "/proj")).toBe("t1-alias T\n\nsome body");
	});

	it("run-gates: renders each gate's pass/fail line", async () => {
		const client = new FakeClient([{ passed: true, gate: { type: "command", target: "x" }, output: "ok" }]);
		const output = await runTaskCli(["run-gates", "t1"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.run_gates", input: { id: "t1", actor: "user", source: "cli" } }]);
		expect(output).toBe("✓ command: x — ok");
	});

	it("set-checklist: requires --checklist-json", async () => {
		const client = new FakeClient(artifact);
		await expect(runTaskCli(["set-checklist", "t1"], client, "/proj")).rejects.toThrow();
	});

	it("set-checklist: threads the parsed checklist", async () => {
		const client = new FakeClient(artifact);
		await runTaskCli(["set-checklist", "t1", "--checklist-json", '{"c":1}'], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.set_checklist", input: { id: "t1", checklist: { c: 1 } } }]);
	});

	it("set-gates: requires --gates-json", async () => {
		const client = new FakeClient(artifact);
		await expect(runTaskCli(["set-gates", "t1"], client, "/proj")).rejects.toThrow();
	});

	it("context: renders the summary or 'no open tasks'", async () => {
		const client = new FakeClient(null);
		expect(await runTaskCli(["context"], client, "/proj")).toBe("No open tasks.");
	});

	it("contain: threads reason and session scope when given", async () => {
		const client = new FakeClient(artifact);
		const output = await runTaskCli(["contain", "t1", "t2", "--reason", "why"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "tasks.contain", input: { parent_id: "t1", child_id: "t2", actor: "user", source: "cli", reason: "why" } },
		]);
		expect(output).toBe("Contained: t2 → t1-alias T");
	});

	it("uncontain: mirrors contain", async () => {
		const client = new FakeClient(artifact);
		const output = await runTaskCli(["uncontain", "t1", "t2"], client, "/proj");
		expect(output).toBe("Removed t2 from t1-alias T");
	});

	it("update: requires at least one of title/body/labels/status=todo", async () => {
		const client = new FakeClient(artifact);
		await expect(runTaskCli(["update", "t1"], client, "/proj")).rejects.toThrow();
	});

	it("update: --status todo requires --reason", async () => {
		const client = new FakeClient(artifact);
		await expect(runTaskCli(["update", "t1", "--status", "todo"], client, "/proj")).rejects.toThrow();
	});

	it("update: --reason without --status todo is rejected", async () => {
		const client = new FakeClient(artifact);
		await expect(runTaskCli(["update", "t1", "--title", "T2", "--reason", "why"], client, "/proj")).rejects.toThrow();
	});

	it("update: --status only supports todo", async () => {
		const client = new FakeClient(artifact);
		await expect(runTaskCli(["update", "t1", "--status", "active"], client, "/proj")).rejects.toThrow();
	});

	it("update: threads title/body/labels and recovers via --status todo --reason", async () => {
		const client = new FakeClient(artifact);
		await runTaskCli(["update", "t1", "--status", "todo", "--reason", "mistake"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "tasks.update", input: { id: "t1", status: "todo", reason: "mistake", actor: "user", source: "cli" } },
		]);
	});

	it("history: renders chronological order", async () => {
		const client = new FakeClient({
			events: [
				{ occurredAt: "2026-01-02T00:00:00.000Z", type: "status", fromStatus: "todo", toStatus: "in-progress", actor: "u", source: "cli" },
				{ occurredAt: "2026-01-01T00:00:00.000Z", type: "created", actor: "u", source: "cli" },
			],
		});
		const output = await runTaskCli(["history", "t1"], client, "/proj");
		expect(output).toContain("created");
	});

	it("scope: no positional reads the current scope", async () => {
		const client = new FakeClient({ mode: "project", label: "papyrus" });
		const output = await runTaskCli(["scope"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.scope", input: { project_root: "/proj" } }]);
		expect(output).toBe("Task scope: papyrus");
	});

	it("scope: sets project/all/graph modes", async () => {
		const client = new FakeClient({ mode: "all", label: "All projects" });
		await runTaskCli(["scope", "all"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "tasks.set_scope", input: { project_root: "/proj", scope: "all" } }]);
	});

	it("scope: graph mode requires a root task id", async () => {
		const client = new FakeClient({});
		await expect(runTaskCli(["scope", "graph"], client, "/proj")).rejects.toThrow();
	});

	it("scope: rejects an invalid mode", async () => {
		const client = new FakeClient({});
		await expect(runTaskCli(["scope", "bogus"], client, "/proj")).rejects.toThrow();
	});

	it("assign-project: defaults the target to the caller's own project root when omitted", async () => {
		const client = new FakeClient(artifact);
		await runTaskCli(["assign-project", "t1"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "tasks.assign_project", input: { id: "t1", project_root: "/proj", actor: "user", source: "cli" } },
		]);
	});

	it("assign-project: an explicit target overrides the caller's project root", async () => {
		const client = new FakeClient(artifact);
		await runTaskCli(["assign-project", "t1", "/explicit"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "tasks.assign_project", input: { id: "t1", project_root: "/explicit", actor: "user", source: "cli" } },
		]);
	});

	it("focus: threads session scope and secret", async () => {
		const client = new FakeClient(artifact);
		await runTaskCli(["focus", "t1", "--session-id", "s1", "--session-secret", "sec"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "tasks.focus", input: { id: "t1", actor: "user", source: "cli", session_id: "s1", session_secret: "sec" } },
		]);
	});

	it("graph: reports node/root/dependency/child counts", async () => {
		const client = new FakeClient({
			nodes: [
				{ dependencyIds: ["a"], childIds: [] },
				{ dependencyIds: [], childIds: ["b", "c"] },
			],
			rootIds: ["r1"],
		});
		const output = await runTaskCli(["graph"], client, "/proj");
		expect(output).toBe("Task graph: 2 nodes, 1 roots, 1 dependencies, 2 containment edges");
	});

	it("plan: renders the execution plan text", async () => {
		const client = new FakeClient({ layers: [], cycleIds: [], nodes: [] });
		const output = await runTaskCli(["plan"], client, "/proj");
		expect(output).toContain("Execution order");
	});

	it("complete: renders completed/rejected, focused, blocked, and gate lines", async () => {
		const client = new FakeClient({
			completed: true,
			artifact,
			focused: { ...artifact, id: "t2", alias: "t2-alias" },
			blocked: [],
			gates: [{ passed: true, gate: { type: "command", target: "x" }, output: "ok" }],
		});
		const output = await runTaskCli(["complete", "t1"], client, "/proj");
		expect(output).toBe("Completed: t1-alias T\nActive: t2-alias T\n✓ command: x — ok");
	});

	it("start: renders 'Started'", async () => {
		const client = new FakeClient(artifact);
		expect(await runTaskCli(["start", "t1"], client, "/proj")).toBe("Started: t1-alias T");
	});

	it("threads lifecycle idempotency keys, including Focus pause", async () => {
		const start = new FakeClient(artifact);
		await runTaskCli(["start", "t1", "--idempotency-key", "start-1"], start, "/proj");
		expect(start.calls[0]?.input).toMatchObject({ id: "t1", idempotency_key: "start-1" });
		const pause = new FakeClient({ artifact, status: "paused" });
		await runTaskCli(["pause", "--idempotency-key", "pause-1"], pause, "/proj");
		expect(pause.calls[0]?.input).toMatchObject({ idempotency_key: "pause-1" });
	});

	it.each(["submit", "reject", "retry", "cancel", "reopen"])("%s: routes to tasks.%s and capitalizes the human line", async (action) => {
		const client = new FakeClient(artifact);
		const output = await runTaskCli([action, "t1"], client, "/proj");
		expect(client.calls).toEqual([{ operation: `tasks.${action}` as OperationName, input: { id: "t1", actor: "user", source: "cli" } }]);
		expect(output).toBe(`${action[0]!.toUpperCase()}${action.slice(1)}: t1-alias T`);
	});

	it("cancel-subtree: reports canceled/skipped counts", async () => {
		const client = new FakeClient({ canceled: ["t1", "t2"], skipped: ["t3"] });
		const output = await runTaskCli(["cancel-subtree", "t1"], client, "/proj");
		expect(output).toBe("Canceled 2 task(s), skipped 1 already-terminal.");
	});

	it("depend: threads reason when given", async () => {
		const client = new FakeClient(artifact);
		const output = await runTaskCli(["depend", "t1", "t2", "--reason", "why"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "tasks.depend", input: { id: "t1", dependency_id: "t2", actor: "user", source: "cli", reason: "why" } },
		]);
		expect(output).toBe("Dependency added: t1-alias T waits for t2");
	});

	it("undepend: mirrors depend", async () => {
		const client = new FakeClient(artifact);
		const output = await runTaskCli(["undepend", "t1", "t2"], client, "/proj");
		expect(output).toBe("Dependency removed: t1-alias T no longer waits for t2");
	});

	it("--reason is rejected on actions that don't support it", async () => {
		const client = new FakeClient(artifact);
		await expect(runTaskCli(["start", "t1", "--reason", "why"], client, "/proj")).rejects.toThrow();
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runTaskCli(["bogus"], client, "/proj")).rejects.toThrow();
	});
});
