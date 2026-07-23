import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);
import { runDiscussCli, runGraphCli, runIdMigrationCli, runLogCli, runMigrationCli, runNoteCli, runSkillCli, runTaskCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { createArtifact, linkArtifacts } from "../src/ops.ts";
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
		const client = new FakeClient({ from: 5, to: 6, applied: ["task-focus-continuation"] });
		expect(await runMigrationCli(["schema", "--json"], client)).toBe(JSON.stringify({
			from: 5,
			to: 6,
			applied: ["task-focus-continuation"],
		}));
		expect(client.calls).toEqual([{ operation: "system.migrate", input: {} }]);
	});
});

describe("Papyrus migrate-ids CLI: mirror, then validate, then promote -- never any other order", () => {
	function seededDbFile(path: string): void {
		const db = openDb(path);
		const a = createArtifact(db, { kind: "doc", title: "A" });
		const b = createArtifact(db, { kind: "doc", title: "B", body: `references ${a.id}` });
		linkArtifacts(db, a.id, "references", b.id);
		db.close();
	}

	it("mirrors, validates, and promotes end to end, and refuses to promote an unvalidated or failed mirror", () => {
		const dir = tempDir("papyrus-cli-id-migration-");
		const source = join(dir, "papyrus.db");
		const mirror = join(dir, "papyrus.mirror.db");
		seededDbFile(source);

		const mirrorOutput = runIdMigrationCli(["mirror", "--db", source, "--out", mirror, "--json"]);
		const mirrorResult = JSON.parse(mirrorOutput) as { artifactsRemapped: number; sidecarPath: string };
		expect(mirrorResult.artifactsRemapped).toBe(2);
		const sidecar = JSON.parse(readFileSync(mirrorResult.sidecarPath, "utf8")) as { idMap: Record<string, string> };
		expect(Object.keys(sidecar.idMap)).toHaveLength(2);

		const validateOutput = runIdMigrationCli(["validate", "--mirror", mirror, "--json"]);
		expect(JSON.parse(validateOutput)).toEqual({ ok: true, problems: [] });

		// The original file is untouched by mirror+validate -- still has the pre-migration ids.
		const untouchedOriginal = openDb(source);
		const originalIds = (untouchedOriginal.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>).map((row) => row.id);
		untouchedOriginal.close();
		expect(originalIds.sort()).toEqual(Object.keys(sidecar.idMap).sort());

		const promoteOutput = runIdMigrationCli(["promote", "--mirror", mirror, "--db", source, "--force", "--json"]);
		const promoteResult = JSON.parse(promoteOutput) as { target: string; backupPath: string };
		expect(promoteResult.target).toBe(source);
		expect(readFileSync(promoteResult.backupPath)).toBeInstanceOf(Buffer); // pre-migration backup was actually written

		const promoted = openDb(source);
		const promotedIds = (promoted.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>).map((row) => row.id);
		promoted.close();
		expect(promotedIds.sort()).toEqual(Object.values(sidecar.idMap).sort()); // production now has the new ids
	});

	it("refuses to promote a mirror that fails validation", () => {
		const dir = tempDir("papyrus-cli-id-migration-");
		const source = join(dir, "papyrus.db");
		const mirror = join(dir, "papyrus.mirror.db");
		seededDbFile(source);
		runIdMigrationCli(["mirror", "--db", source, "--out", mirror, "--json"]);

		// Sabotage the mirror after the fact, simulating a broken migration.
		const db = openDb(mirror);
		db.exec("PRAGMA foreign_keys = OFF");
		db.exec("UPDATE edges SET from_id = 'not-a-real-id' WHERE rowid = (SELECT rowid FROM edges LIMIT 1)");
		db.close();

		expect(() => runIdMigrationCli(["promote", "--mirror", mirror, "--db", source, "--force", "--json"])).toThrow(/failed validation/);
		// Production is untouched by the refused promotion.
		const stillOriginal = openDb(source);
		const stillOriginalTitles = (stillOriginal.prepare("SELECT title FROM artifacts ORDER BY title").all() as Array<{ title: string }>).map((row) => row.title);
		stillOriginal.close();
		expect(stillOriginalTitles).toEqual(["A", "B"]);
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

	it("requires a known action", async () => {
		const client = new FakeClient({});
		await expect(runGraphCli([], client)).rejects.toThrow("graph action must be link, unlink, tree, status, or history");
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

describe("Papyrus log CLI", () => {
	it("appends a log entry through the authenticated daemon, defaulting to the caller's project scope", async () => {
		const appended = { entry: { id: "e1", sourceId: "pi-session-context", message: "turn settled" }, replayed: false };
		const client = new FakeClient(appended);
		expect(await runLogCli(["append", "--source", "pi-session-context", "--level", "info", "--message", "turn settled", "--operation-id", "s1:1", "--json"], client)).toBe(JSON.stringify(appended));
		expect(client.calls).toEqual([{
			operation: "logs.append",
			input: { source_id: "pi-session-context", project_root: PROJECT_ROOT, level: "info", message: "turn settled", operation_id: "s1:1" },
		}]);
	});

	it("passes through structured fields, session id, and an explicit historical timestamp", async () => {
		const client = new FakeClient({ entry: { id: "e1" }, replayed: false });
		await runLogCli([
			"append", "--source", "s", "--level", "warning", "--message", "m", "--operation-id", "op-1",
			"--fields-json", '{"totalTokens":123}', "--session-id", "ses-1", "--occurred-at", "2020-01-01T00:00:00.000Z",
		], client);
		expect(client.calls).toEqual([{
			operation: "logs.append",
			input: {
				source_id: "s", project_root: PROJECT_ROOT, level: "warning", message: "m", operation_id: "op-1",
				fields: { totalTokens: 123 }, session_id: "ses-1", occurred_at: "2020-01-01T00:00:00.000Z",
			},
		}]);
	});

	it("omits project_root when --global is passed, for a source that is not tied to one project", async () => {
		const client = new FakeClient({ entry: { id: "e1" }, replayed: false });
		await runLogCli(["append", "--source", "s", "--level", "info", "--message", "m", "--operation-id", "op-1", "--global"], client);
		expect(client.calls).toEqual([{ operation: "logs.append", input: { source_id: "s", level: "info", message: "m", operation_id: "op-1" } }]);
	});

	it("rejects append missing any required flag", async () => {
		const client = new FakeClient({});
		await expect(runLogCli(["append", "--level", "info", "--message", "m", "--operation-id", "op-1"], client)).rejects.toThrow(/--source/);
		await expect(runLogCli(["append", "--source", "s", "--message", "m", "--operation-id", "op-1"], client)).rejects.toThrow(/--level/);
		await expect(runLogCli(["append", "--source", "s", "--level", "info", "--operation-id", "op-1"], client)).rejects.toThrow(/--message/);
		await expect(runLogCli(["append", "--source", "s", "--level", "info", "--message", "m"], client)).rejects.toThrow(/--operation-id/);
	});

	it("queries entries with since/level/limit filters and renders a human-readable page", async () => {
		const page = { entries: [{ id: "e1", message: "m1" }], truncated: true };
		const client = new FakeClient(page);
		const output = await runLogCli(["query", "--source", "s", "--since", "2024-01-01T00:00:00.000Z", "--level", "warning", "--limit", "10"], client);
		expect(client.calls).toEqual([{ operation: "logs.query", input: { source_id: "s", since: "2024-01-01T00:00:00.000Z", level: "warning", limit: 10 } }]);
		expect(output).toContain("truncated");
	});

	it("prints stable JSON for machine consumers", async () => {
		const page = { entries: [], truncated: false };
		const client = new FakeClient(page);
		expect(await runLogCli(["query", "--source", "s", "--json"], client)).toBe(JSON.stringify(page));
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

describe("Papyrus Discuss CLI", () => {
	it("translates --options-json/--options-mode into discuss.open", async () => {
		const client = new FakeClient({ discussion: { id: "d1" }, rounds: [] });
		await runDiscussCli([
			"open", "--title", "Pick one", "--actor", "alice", "--content", "A or B?",
			"--options-json", '["A","B"]', "--options-mode", "single", "--json",
		], client);
		expect(client.calls).toEqual([{
			operation: "discuss.open",
			input: {
				title: "Pick one", actor: "alice", content: "A or B?", body: undefined, labels: undefined,
				blocks_task_ids: undefined, options: ["A", "B"], options_mode: "single",
			},
		}]);
	});

	it("translates --selected-json into discuss.reply, answering a pending choice", async () => {
		const client = new FakeClient({ discussion: { id: "d1" }, rounds: [] });
		await runDiscussCli(["reply", "d1", "--actor", "bob", "--content", "Going with B", "--selected-json", '["B"]', "--json"], client);
		expect(client.calls).toEqual([{
			operation: "discuss.reply",
			input: { id: "d1", actor: "bob", content: "Going with B", selected: ["B"], options: undefined, options_mode: undefined },
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
			input: { id: "task", dependency_id: "prerequisite", actor: "user", source: "cli" },
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

	it("creates a task through the daemon client -- the daemon operation already supports this; only the CLI route was missing", async () => {
		const client = new FakeClient({ id: "new-task", title: "New task", status: "todo" });
		const output = await runTaskCli([
			"create", "--title", "New task", "--body", "Body text", "--status", "todo",
			"--labels-json", '["a","b"]', "--extra-json", '{"k":"v"}',
			"--gates-json", '[{"type":"command","target":"bun test"}]',
			"--checklist-json", '{"done":{"proof":[{"type":"artifact","target":"x"}]}}',
			"--template-id", "tmpl-1", "--parent-id", "epic-1", "--depends-on-json", '["prereq-1"]',
		], client);
		expect(client.calls).toEqual([{
			operation: "tasks.create",
			input: {
				title: "New task", body: "Body text", status: "todo", labels: ["a", "b"], extra: { k: "v" },
				gates: [{ type: "command", target: "bun test" }],
				checklist: { done: { proof: [{ type: "artifact", target: "x" }] } },
				template_id: "tmpl-1", parent_id: "epic-1", depends_on: ["prereq-1"],
				project_root: PROJECT_ROOT, actor: "user", source: "cli",
			},
		}]);
		expect(output).toBe("Created task: new-task New task");
	});

	it("creates a task with only the required --title, defaulting everything else", async () => {
		const client = new FakeClient({ id: "t", title: "T", status: "todo" });
		await runTaskCli(["create", "--title", "T", "--json"], client);
		expect(client.calls).toEqual([{
			operation: "tasks.create",
			input: { title: "T", project_root: PROJECT_ROOT, actor: "user", source: "cli" },
		}]);
	});

	it("rejects tasks create with no --title rather than silently sending an invalid request", async () => {
		const client = new FakeClient({});
		await expect(runTaskCli(["create"], client)).rejects.toThrow("tasks create requires --title");
		expect(client.calls).toEqual([]);
	});

	it("lists tasks through the daemon client", async () => {
		const rows = [{ id: "a", title: "A", status: "todo" }, { id: "b", title: "B", status: "done" }];
		const client = new FakeClient(rows);
		const output = await runTaskCli(["list", "--status", "todo", "--text", "query", "--limit", "10"], client);
		expect(client.calls).toEqual([{
			operation: "tasks.list",
			input: { status: "todo", text: "query", limit: 10, project_root: PROJECT_ROOT },
		}]);
		expect(output).toBe("a A\nb B");

		const emptyClient = new FakeClient([]);
		expect(await runTaskCli(["list"], emptyClient)).toBe("No tasks found.");
	});

	it("shows one task through the daemon client", async () => {
		const client = new FakeClient({ id: "task", title: "Task", status: "todo", body: "Details" });
		const output = await runTaskCli(["show", "task"], client);
		expect(client.calls).toEqual([{ operation: "tasks.show", input: { id: "task" } }]);
		expect(output).toBe("task Task\n\nDetails");
	});

	it("rejects tasks show without exactly one task id", async () => {
		const client = new FakeClient({});
		await expect(runTaskCli(["show"], client)).rejects.toThrow("tasks show requires exactly one task id");
	});
});
