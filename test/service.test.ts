import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapyrusClient } from "../src/client.ts";
import { openDb } from "../src/db.ts";
import { EXPECTED_OPERATION_NAMES, createApp, createPapyrusService } from "../src/service.ts";
import { VERSION } from "../src/version.ts";

const PROJECT_ROOT = "/workspace/papyrus";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "papyrus-service-"));
	const service = createPapyrusService(join(dir, "papyrus.db"));
	const app = createApp({ service, token: "test-token" });
	return { dir, service, app };
}

function request(app: { fetch(request: Request): Promise<Response> }, path: string, init: RequestInit = {}) {
	return app.fetch(new Request(`http://papyrus.test${path}`, {
		...init,
		headers: { authorization: "Bearer test-token", "content-type": "application/json", ...init.headers },
	}));
}

describe("Papyrus operation service", () => {
	it("registers a service operation for every low-level and current domain action", () => {
		const { service } = fixture();
		expect(service.operationNames()).toEqual([...EXPECTED_OPERATION_NAMES]);
		expect(EXPECTED_OPERATION_NAMES).toContain("artifact.create");
		expect(EXPECTED_OPERATION_NAMES).toContain("graph.tree");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.complete");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.graph");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.plan");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.set_checklist");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.active");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.focus");
		expect(EXPECTED_OPERATION_NAMES).toContain("automation.status");
		expect(EXPECTED_OPERATION_NAMES).toContain("automation.reconcile");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.submit");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.set_automation");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.reject");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.cancel");
		expect(EXPECTED_OPERATION_NAMES).toContain("docs.archive");
		expect(EXPECTED_OPERATION_NAMES).toContain("rules.preview");
		expect(EXPECTED_OPERATION_NAMES).toContain("skills.instantiate");
		expect(EXPECTED_OPERATION_NAMES).toContain("skills.run");
		expect(EXPECTED_OPERATION_NAMES).toContain("system.migrate");
		service.close();
	});

	it("starts without migrating old data and permits only explicit migration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "papyrus-service-migration-"));
		const path = join(dir, "papyrus.db");
		const legacy = openDb(path);
		legacy.exec(`
			INSERT OR IGNORE INTO statuses VALUES ('pending','task');
			INSERT OR IGNORE INTO statuses VALUES ('active','task');
			INSERT OR IGNORE INTO statuses VALUES ('failed','task');
			DELETE FROM statuses WHERE kind = 'task' AND name IN ('todo','in-progress','review','rejected','canceled');
			DROP TABLE task_views;
			DROP TABLE task_scopes;
			DROP TABLE task_focus;
			DROP TRIGGER task_events_no_update;
			DROP TRIGGER task_events_no_delete;
			DROP TABLE task_events;
			PRAGMA user_version = 1;
		`);
		legacy.close();

		const service = createPapyrusService(path);
		expect(service.schemaState()).toEqual({ current: 1, required: 4, migrationRequired: true });
		await expect(service.execute("tasks.list", {})).rejects.toThrow("papyrus migrate task-scope");
		expect(await service.execute("system.migrate", {})).toEqual({
			from: 1,
			to: 4,
			applied: ["task-lifecycle-and-focus", "task-history", "task-project-scope"],
		});
		expect(service.schemaState()).toEqual({ current: 4, required: 4, migrationRequired: false });
		expect(await service.execute("tasks.list", { project_root: PROJECT_ROOT })).toEqual([]);
		service.close();
	});

	it("keeps daemon automation off unless explicitly enabled", async () => {
		const { service } = fixture();
		expect(await service.execute("automation.status", {})).toMatchObject({ enabled: false, inFlight: false });
		expect(await service.execute("automation.reconcile", {})).toMatchObject({ skipped: "disabled", examined: 0 });
		service.close();
	});

	it("requires explicit project scope on Task view and creation boundaries", async () => {
		const { service } = fixture();
		await expect(service.execute("tasks.create", { title: "Unscoped by accident" })).rejects.toThrow("project_root is required");
		await expect(service.execute("tasks.graph", {})).rejects.toThrow("project_root is required");
		service.close();
	});

	it("dispatches low-level and task operations through one endpoint", async () => {
		const { service, app } = fixture();
		const created = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "tasks.create", input: { title: "Serve tasks", project_root: PROJECT_ROOT } }),
		});
		expect(created.status).toBe(200);
		const task = (await created.json()) as { result: { id: string; kind: string } };
		expect(task.result.kind).toBe("task");
		await service.execute("tasks.set_automation", { id: task.result.id, enabled: true, actor: "user", source: "test" });
		const history = await service.execute("tasks.history", { id: task.result.id, direction: "asc" }) as { events: Array<{ type: string; actor: string }> };
		expect(history.events).toEqual([
			expect.objectContaining({ type: "created", actor: "system" }),
			expect.objectContaining({ type: "automation_enabled", actor: "user", source: "test" }),
		]);
		const lowLevelTask = await service.execute("artifact.create", { kind: "task", title: "Low-level task", actor: "agent", project_root: PROJECT_ROOT }) as { id: string };
		expect(await service.execute("tasks.history", { id: lowLevelTask.id }) as unknown).toEqual(expect.objectContaining({
			events: [expect.objectContaining({ type: "created", actor: "agent", source: "artifact-api" })],
		}));
		await expect(service.execute("graph.status", { id: lowLevelTask.id, status: "done" })).rejects.toThrow("tasks.* operation");

		const listed = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "artifact.query", input: { kind: "task" } }),
		});
		expect(((await listed.json()) as { result: unknown[] }).result).toHaveLength(2);

		const graph = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "tasks.graph", input: { project_root: PROJECT_ROOT } }),
		});
		expect(((await graph.json()) as { result: { nodes: unknown[]; rootIds: string[] } }).result.nodes).toHaveLength(2);

		const checklist = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({
				op: "tasks.set_checklist",
				input: {
					id: task.result.id,
					checklist: { "Serve requests": { proof: [{ type: "test", target: "test/service.test.ts" }] } },
				},
			}),
		});
		expect(((await checklist.json()) as { result: { extra: Record<string, unknown> } }).result.extra["checklist"]).toEqual({
			"Serve requests": { proof: [{ type: "test", target: "test/service.test.ts" }] },
		});

		const operations = await request(app, "/api/v1/ops");
		expect((await operations.json()) as unknown).toEqual({ operations: EXPECTED_OPERATION_NAMES });
		service.close();
	});

	it("runs workflow Skills atomically and injects run rules only for active run tasks", async () => {
		const { service } = fixture();
		const skill = await service.execute("skills.create", {
			title: "Scoped workflow",
			definition: {
				version: 1,
				inputs: { project: { type: "string", required: true } },
				blueprints: {
					docs: [],
					rules: [{ ref: "rule", title: "Scoped rule", body: "Only this run" }],
					tasks: [{ ref: "task", title: "Work on {{project}}" }],
				},
				links: [],
			},
		}) as { id: string };
		const run = await service.execute("skills.run", {
			id: skill.id,
			run_id: "service-run",
			arguments: { project: "Papyrus" },
			project_root: PROJECT_ROOT,
		}) as { created: { tasks: string[]; rules: string[] }; rootTaskIds: string[] };
		expect(run.rootTaskIds).toEqual(["service-run-task"]);
		const runHistory = await service.execute("tasks.history", { id: run.created.tasks[0] }) as { events: Array<{ type: string; source: string }> };
		expect(runHistory.events).toEqual([expect.objectContaining({ type: "created", source: "skill-run" })]);
		await service.execute("tasks.focus", { id: run.created.tasks[0] });
		expect(await service.execute("rules.injectable", { project_root: PROJECT_ROOT })).toEqual([
			expect.objectContaining({ id: run.created.rules[0], title: "Scoped rule" }),
		]);

		const unrelated = await service.execute("tasks.create", { title: "Unrelated", project_root: PROJECT_ROOT }) as { id: string };
		await service.execute("tasks.focus", { id: unrelated.id });
		expect(await service.execute("rules.injectable", { project_root: PROJECT_ROOT })).toEqual([]);
		service.close();
	});

	it("exposes execution plans and gated successor advancement", async () => {
		const { service } = fixture();
		const prerequisite = await service.execute("tasks.create", { title: "Prerequisite", status: "review", project_root: PROJECT_ROOT }) as { id: string };
		const left = await service.execute("tasks.create", { title: "Left", depends_on: [prerequisite.id], project_root: PROJECT_ROOT }) as { id: string };
		const right = await service.execute("tasks.create", { title: "Right", depends_on: [prerequisite.id], project_root: PROJECT_ROOT }) as { id: string };

		const before = await service.execute("tasks.plan", { project_root: PROJECT_ROOT }) as {
			layers: string[][];
			nodes: Array<{ id: string; state: string }>;
		};
		expect(before.layers[0]).toEqual([prerequisite.id]);
		expect([...before.layers[1]!].sort()).toEqual([left.id, right.id].sort());
		expect((await service.execute("tasks.plan", { project_root: PROJECT_ROOT }) as { layers: string[][] }).layers).toEqual(before.layers);
		expect(before.nodes.find((node) => node.id === left.id)?.state).toBe("blocked");

		const completion = await service.execute("tasks.complete", { id: prerequisite.id }) as {
			completed: boolean;
			focused: { id: string; status: string } | null;
		};
		expect(completion.completed).toBe(true);
		expect(completion.focused?.id).toBe(left.id);
		expect(completion.focused?.status).toBe("todo");
		service.close();
	});

	it("rejects dependency cycles through the daemon boundary", async () => {
		const { service } = fixture();
		const first = await service.execute("tasks.create", { title: "First", project_root: PROJECT_ROOT }) as { id: string };
		const second = await service.execute("tasks.create", { title: "Second", depends_on: [first.id], project_root: PROJECT_ROOT }) as { id: string };

		await expect(service.execute("tasks.depend", { id: first.id, dependency_id: second.id })).rejects.toThrow("dependency cycle");
		await expect(service.execute("graph.link", { from: first.id, relation: "depends_on", to: second.id })).rejects.toThrow("dependency cycle");
		service.close();
	});

	it("requires authentication and reports unknown operations", async () => {
		const { service, app } = fixture();
		const unauthorized = await app.fetch(new Request("http://papyrus.test/health"));
		expect(unauthorized.status).toBe(401);
		const unknown = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "unknown.operation", input: {} }),
		});
		expect(unknown.status).toBe(404);
		service.close();
	});

	it("provides a typed client over the same HTTP adapter", async () => {
		const { service, app } = fixture();
		const client = new PapyrusClient("http://papyrus.test", "test-token", (request) => app.fetch(request));
		expect(await client.health()).toEqual({
			ok: true,
			version: VERSION,
			schema: { current: 4, required: 4, migrationRequired: false },
		});
		const task = await client.call<{ title: string; project_root: string }, { id: string; kind: string }>("tasks.create", { title: "Client task", project_root: PROJECT_ROOT });
		expect(task.kind).toBe("task");
		expect((await client.operations()).length).toBe(EXPECTED_OPERATION_NAMES.length);
		service.close();
	});
});
