import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

import { PapyrusClient } from "../src/client.ts";
import { openDb } from "../src/db.ts";
import { createApp, createPapyrusService, EXPECTED_OPERATION_NAMES } from "../src/service.ts";
import { VERSION } from "../src/version.ts";

const PROJECT_ROOT = "/workspace/papyrus";

function fixture() {
	const dir = tempDir("papyrus-service-");
	const service = createPapyrusService(join(dir, "papyrus.db"));
	const app = createApp({ service, token: "test-token" });
	return { dir, service, app };
}

function request(app: { fetch(request: Request): Promise<Response> }, path: string, init: RequestInit = {}) {
	return app.fetch(
		new Request(`http://papyrus.test${path}`, {
			...init,
			headers: { authorization: "Bearer test-token", "content-type": "application/json", ...init.headers },
		}),
	);
}

describe("Papyrus operation service", () => {
	it("registers a service operation for every low-level and current domain action", () => {
		const { service } = fixture();
		expect(service.operationNames()).toEqual([...EXPECTED_OPERATION_NAMES]);
		expect(EXPECTED_OPERATION_NAMES).toContain("artifact.create");
		expect(EXPECTED_OPERATION_NAMES).toContain("logs.append");
		expect(EXPECTED_OPERATION_NAMES).toContain("graph.tree");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.complete");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.update");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.graph");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.plan");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.set_checklist");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.active");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.focus");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.focused");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.pause");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.unpause");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.clear_focus");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.submit");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.reject");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.cancel");
		expect(EXPECTED_OPERATION_NAMES).toContain("docs.archive");
		expect(EXPECTED_OPERATION_NAMES).toContain("rules.preview");
		expect(EXPECTED_OPERATION_NAMES).toContain("playbooks.invoke");
		expect(EXPECTED_OPERATION_NAMES).toContain("system.migrate");
		service.close();
	});

	it("starts without migrating old data and permits only explicit migration", async () => {
		const dir = tempDir("papyrus-service-migration-");
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
			DROP TRIGGER artifact_events_no_update;
			DROP TRIGGER artifact_events_no_delete;
			DROP TABLE artifact_events;
			PRAGMA user_version = 1;
		`);
		legacy.close();

		const service = createPapyrusService(path);
		expect(service.schemaState()).toEqual({ current: 1, required: 28, migrationRequired: true });
		await expect(service.execute("tasks.list", {})).rejects.toThrow("papyrus migrate schema");
		expect(await service.execute("system.migrate", {})).toEqual({
			from: 1,
			to: 28,
			applied: [
				"task-lifecycle-and-focus",
				"task-history",
				"task-project-scope",
				"task-focus-continuation",
				"discourse-context-mesh",
				"artifact-event-log",
				"task-focus-session-scope",
				"graph-projection-protocol",
				"docs-rules-skills-project-scope",
				"log-domain",
				"remove-discourse",
				"session-identity",
				"artifact-trash",
				"discuss-native",
				"discuss-options",
				"discussion-task-kind",
				"playbook-kind",
				"discuss-option-descriptions",
				"task-leases",
				"note-events",
				"skill-to-playbook-data-migration",
				"retire-skill-kind",
				"artifact-aliases",
				"rule-draft-status",
				"task-projects-and-create-idempotency",
				"task-lifecycle-mutation-receipts",
				"artifact-multi-project-scope",
			],
		});
		expect(service.schemaState()).toEqual({ current: 28, required: 28, migrationRequired: false });
		expect(await service.execute("tasks.list", { project_root: PROJECT_ROOT })).toEqual([]);
		service.close();
	});

	/**
	 * Real incident: restarting the live daemon onto new code without running `papyrus migrate
	 * schema` first left the real production database at an older schema version. The legacy
	 * execute()/`/api/v1/ops` path already refuses cleanly (see the migration test above) --
	 * but every domain (tasks/docs/rules/discuss/notes/playbooks) is now ALSO reachable through
	 * `/vehicle/invoke` directly (registry.invoke(), bypassing execute() entirely), which had no
	 * equivalent guard: a stale schema surfaced as an opaque "handler-failed" (or worse, silent
	 * success) the moment a request touched a column/table the old schema never had, instead of
	 * the same clear, actionable message the legacy path already gives.
	 */
	it("refuses every /vehicle/invoke call with a clear, classified error when the database needs an explicit migration, matching the legacy execute() path", async () => {
		const dir = tempDir("papyrus-service-vehicle-migration-");
		const path = join(dir, "papyrus.db");
		const legacy = openDb(path);
		legacy.exec(`DROP INDEX IF EXISTS artifacts_alias_idx; ALTER TABLE artifacts DROP COLUMN alias; PRAGMA user_version = 23;`);
		legacy.close();

		const service = createPapyrusService(path);
		const app = createApp({ service, token: "test-token" });
		expect(service.schemaState()).toEqual({ current: 23, required: 28, migrationRequired: true });

		const response = await request(app, "/vehicle/invoke", {
			method: "POST",
			body: JSON.stringify({
				name: "tasks.show",
				version: 1,
				input: { name: "Anything", project_root: PROJECT_ROOT },
				permissions: ["tasks:read", "tasks:write"],
			}),
		});
		expect(response.status).toBe(503);
		const body = (await response.json()) as { error: { code: string; category: string; message: string } };
		expect(body.error.code).toBe("migration-required");
		expect(body.error.category).toBe("unavailable");
		expect(body.error.message).toContain("papyrus migrate schema");
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
		await service.execute("tasks.update", { id: task.result.id, title: "Serve updated tasks", actor: "user", source: "test" });
		await service.execute("tasks.focus", { id: task.result.id, actor: "user", source: "test" });
		await service.execute("tasks.pause", { actor: "user", source: "test", reason: "manual pause" });
		expect(await service.execute("tasks.focused", { project_root: PROJECT_ROOT })).toEqual(
			expect.objectContaining({ status: "paused", pauseReason: "manual pause" }),
		);
		await service.execute("tasks.unpause", { actor: "user", source: "test" });
		const history = (await service.execute("tasks.history", { id: task.result.id, direction: "asc" })) as {
			events: Array<{ type: string; actor: string }>;
		};
		expect(history.events).toEqual([
			expect.objectContaining({ type: "created", actor: "system" }),
			expect.objectContaining({ type: "updated", actor: "user", source: "test" }),
			expect.objectContaining({ type: "focus_set", actor: "user", source: "test" }),
			expect.objectContaining({ type: "focus_paused", actor: "user", source: "test" }),
			expect.objectContaining({ type: "focus_unpaused", actor: "user", source: "test" }),
		]);
		const lowLevelTask = (await service.execute("artifact.create", {
			kind: "task",
			title: "Low-level task",
			actor: "agent",
			project_root: PROJECT_ROOT,
		})) as { id: string };
		expect((await service.execute("tasks.history", { id: lowLevelTask.id })) as unknown).toEqual(
			expect.objectContaining({
				events: [expect.objectContaining({ type: "created", actor: "agent", source: "artifact-api" })],
			}),
		);
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
		expect(((await checklist.json()) as { result: { extra: Record<string, unknown> } }).result.extra.checklist).toEqual({
			"Serve requests": { proof: [{ type: "test", target: "test/service.test.ts" }] },
		});

		const operations = await request(app, "/api/v1/ops");
		expect((await operations.json()) as unknown).toEqual({ operations: EXPECTED_OPERATION_NAMES });
		service.close();
	});

	it("runs Playbooks atomically and injects run rules only for active run tasks", async () => {
		const { service } = fixture();
		const playbook = (await service.execute("playbooks.create", {
			title: "Scoped workflow",
			steps: [{ kind: "rule", title: "Scoped rule", body: "Only this run" }, "Work on {{project}}"],
			arguments: [{ name: "project", required: true }],
		})) as { id: string };
		const run = (await service.execute("playbooks.invoke", {
			id: playbook.id,
			run_id: "service-run",
			arguments: { project: "Papyrus" },
			project_root: PROJECT_ROOT,
		})) as { created: { tasks: string[]; rules: string[] }; entryTaskId: string };
		expect(run.entryTaskId).toBe("service-run-pb0-s1");
		const runHistory = (await service.execute("tasks.history", { id: run.entryTaskId })) as {
			events: Array<{ type: string; source: string }>;
		};
		expect(runHistory.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "created", source: "playbook-run" })]));
		expect(await service.execute("rules.injectable", { project_root: PROJECT_ROOT })).toEqual([
			expect.objectContaining({ id: run.created.rules[0], title: "Scoped rule" }),
		]);

		const unrelated = (await service.execute("tasks.create", { title: "Unrelated", project_root: PROJECT_ROOT })) as { id: string };
		await service.execute("tasks.focus", { id: unrelated.id });
		expect(await service.execute("rules.injectable", { project_root: PROJECT_ROOT })).toEqual([]);
		service.close();
	});

	it("injects a project-bound Rule only in its registered project memberships -- global, project A only, projects A+B, project B only, and unknown-project cases (rules-enforce-global-or-multi-project-applicabilit)", async () => {
		const { service } = fixture();
		const PROJECT_A = "/workspace/project-a";
		const PROJECT_B = "/workspace/project-b";
		await service.execute("tasks.register_project", { project_root: PROJECT_A, name: "Project A" });
		await service.execute("tasks.register_project", { project_root: PROJECT_B, name: "Project B" });

		const globalRule = (await service.execute("rules.create", { title: "Global rule", body: "Applies everywhere" })) as { id: string };
		const ruleA = (await service.execute("rules.create", {
			title: "Project A only",
			body: "Only Project A",
			projects: ["Project A"],
		})) as { id: string };
		const ruleAB = (await service.execute("rules.create", {
			title: "Projects A and B",
			body: "Both projects",
			projects: ["Project A", "Project B"],
		})) as { id: string };
		const ruleB = (await service.execute("rules.create", {
			title: "Project B only",
			body: "Only Project B",
			projects: ["Project B"],
		})) as { id: string };

		const idsIn = async (projectRoot: string) =>
			((await service.execute("rules.injectable", { project_root: projectRoot })) as Array<{ id: string }>).map((rule) => rule.id).sort();

		expect(await idsIn(PROJECT_A)).toEqual([globalRule.id, ruleA.id, ruleAB.id].sort());
		expect(await idsIn(PROJECT_B)).toEqual([globalRule.id, ruleAB.id, ruleB.id].sort());
		// An unregistered project root: only the global rule can possibly apply, since nothing was
		// ever registered under it to be a member of.
		expect(await idsIn("/workspace/never-registered")).toEqual([globalRule.id]);
		service.close();
	});

	it("composes run scope and project scope with AND semantics -- a playbook-run Rule requires both an active run task and a matching project membership, inherited AUTOMATICALLY from the invocation destination (playbooks-add-multi-project-applicability-and-prop)", async () => {
		const { service } = fixture();
		const PROJECT_A = "/workspace/run-project-a";
		const PROJECT_B = "/workspace/run-project-b";
		await service.execute("tasks.register_project", { project_root: PROJECT_A, name: "Run Project A" });
		await service.execute("tasks.register_project", { project_root: PROJECT_B, name: "Run Project B" });

		const playbook = (await service.execute("playbooks.create", {
			title: "Scoped-to-A workflow",
			steps: [{ kind: "rule", title: "Run+project scoped rule", body: "Only this run, only Project A" }, "Work on {{project}}"],
			arguments: [{ name: "project", required: true }],
		})) as { id: string };
		const run = (await service.execute("playbooks.invoke", {
			id: playbook.id,
			run_id: "and-semantics-run",
			arguments: { project: "Papyrus" },
			project_root: PROJECT_A,
		})) as { created: { rules: string[] }; entryTaskId: string };
		const ruleId = run.created.rules[0]!;

		// No manual rules.replace_projects call -- materializeWorkflowDefinition now assigns the
		// generated Rule's project membership to the invocation's own destination automatically,
		// the same way it already did for generated Tasks. Real, confirmed gap this closes:
		// generated Docs/Rules previously bypassed ArtifactScopeStore entirely, so a run-created
		// Rule was global by default and injected into every project's context regardless of
		// where it was actually invoked.
		const generatedScope = (await service.execute("rules.scope", { id: ruleId })) as { mode: string; projectIds: string[] };
		expect(generatedScope.mode).toBe("projects");
		expect(generatedScope.projectIds).toHaveLength(1);

		// Active run task AND matching project: passes.
		expect(await service.execute("rules.injectable", { project_root: PROJECT_A })).toEqual([expect.objectContaining({ id: ruleId })]);
		// Active run task, but the WRONG project: run-gating alone must not bypass project scope.
		expect(await service.execute("rules.injectable", { project_root: PROJECT_B })).toEqual([]);

		const unrelated = (await service.execute("tasks.create", { title: "Unrelated", project_root: PROJECT_A })) as { id: string };
		await service.execute("tasks.focus", { id: unrelated.id });
		// Matching project, but no active run task: project scope alone must not bypass run-gating.
		expect(await service.execute("rules.injectable", { project_root: PROJECT_A })).toEqual([]);
		service.close();
	});

	it("a playbook invoked with no destination project_root leaves its generated Docs/Rules unscoped/global, matching every artifact created before project scoping existed", async () => {
		const { service } = fixture();
		const playbook = (await service.execute("playbooks.create", {
			title: "Unscoped workflow",
			steps: [
				{ kind: "doc", title: "Unscoped generated doc" },
				{ kind: "rule", title: "Unscoped generated rule", body: "Applies everywhere" },
				"Plain step",
			],
		})) as { id: string };
		const run = (await service.execute("playbooks.invoke", { id: playbook.id, run_id: "unscoped-run" })) as {
			created: { docs: string[]; rules: string[] };
		};
		const docScope = (await service.execute("docs.scope", { id: run.created.docs[0] })) as { mode: string };
		expect(docScope.mode).toBe("global");
		const ruleScope = (await service.execute("rules.scope", { id: run.created.rules[0] })) as { mode: string };
		expect(ruleScope.mode).toBe("global");
		service.close();
	});

	it("a nested playbook call step inherits the SAME destination project atomically, not a separately-resolved one", async () => {
		const { service } = fixture();
		const PROJECT = "/workspace/nested-run-project";
		await service.execute("tasks.register_project", { project_root: PROJECT, name: "Nested Run Project" });

		const nested = (await service.execute("playbooks.create", {
			title: "Nested workflow",
			steps: [{ kind: "rule", title: "Nested generated rule", body: "From the nested call" }],
		})) as { id: string };
		const parent = (await service.execute("playbooks.create", {
			title: "Parent workflow",
			steps: [{ kind: "call", title: "Call nested", playbookId: nested.id }],
		})) as { id: string };
		const run = (await service.execute("playbooks.invoke", {
			id: parent.id,
			run_id: "nested-destination-run",
			project_root: PROJECT,
		})) as { created: { rules: string[] } };
		expect(run.created.rules).toHaveLength(1);
		const nestedRuleScope = (await service.execute("rules.scope", { id: run.created.rules[0] })) as { mode: string; projectIds: string[] };
		expect(nestedRuleScope.mode).toBe("projects");
		expect(nestedRuleScope.projectIds).toHaveLength(1);
		service.close();
	});

	it("exposes execution plans and gated successor advancement", async () => {
		const { service } = fixture();
		const prerequisite = (await service.execute("tasks.create", {
			title: "Prerequisite",
			status: "review",
			project_root: PROJECT_ROOT,
		})) as { id: string };
		const left = (await service.execute("tasks.create", { title: "Left", depends_on: [prerequisite.id], project_root: PROJECT_ROOT })) as {
			id: string;
		};
		const right = (await service.execute("tasks.create", {
			title: "Right",
			depends_on: [prerequisite.id],
			project_root: PROJECT_ROOT,
		})) as { id: string };

		const before = (await service.execute("tasks.plan", { project_root: PROJECT_ROOT })) as {
			layers: string[][];
			nodes: Array<{ id: string; state: string }>;
		};
		expect(before.layers[0]).toEqual([prerequisite.id]);
		expect([...before.layers[1]!].sort()).toEqual([left.id, right.id].sort());
		expect(((await service.execute("tasks.plan", { project_root: PROJECT_ROOT })) as { layers: string[][] }).layers).toEqual(before.layers);
		expect(before.nodes.find((node) => node.id === left.id)?.state).toBe("blocked");

		const completion = (await service.execute("tasks.complete", { id: prerequisite.id })) as {
			completed: boolean;
			focused: { id: string; status: string } | null;
		};
		expect(completion.completed).toBe(true);
		// The tie-break among equally-ready successors is deterministic by sorted id (see
		// task-service.ts's `[...successorIds].sort()`) -- not by which one was titled "Left".
		// That assumption held only by coincidence when ids were title-derived slugs; ids are
		// now opaque UUIDs, so assert the actual contract instead of a stale implementation detail.
		const [expectedWinnerId] = [left.id, right.id].sort();
		expect(completion.focused?.id).toBe(expectedWinnerId);
		expect(completion.focused?.status).toBe("todo");
		service.close();
	});

	it("rejects dependency cycles through the daemon boundary", async () => {
		const { service } = fixture();
		const first = (await service.execute("tasks.create", { title: "First", project_root: PROJECT_ROOT })) as { id: string };
		const second = (await service.execute("tasks.create", { title: "Second", depends_on: [first.id], project_root: PROJECT_ROOT })) as {
			id: string;
		};

		await expect(service.execute("tasks.depend", { id: first.id, dependency_id: second.id })).rejects.toThrow("dependency cycle");
		await expect(service.execute("graph.link", { from: first.id, relation: "depends_on", to: second.id })).rejects.toThrow(
			"dependency cycle",
		);
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

	it("maps a forged session_secret to HTTP 403 through the real daemon boundary, once that session_id is registered", async () => {
		const { service, app } = fixture();
		const client = new PapyrusClient("http://papyrus.test", "test-token", (request) => app.fetch(request));
		const task = await client.call<{ title: string; project_root: string }, { id: string }>("tasks.create", {
			title: "Armored",
			project_root: PROJECT_ROOT,
		});
		await client.call("session.register", { session_id: "session-a" });

		const forged = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "tasks.focus", input: { id: task.id, session_id: "session-a", session_secret: "forged" } }),
		});
		expect(forged.status).toBe(403);

		const { secret } = await client.call<{ session_id: string }, { sessionId: string; secret: string }>("session.register", {
			session_id: "session-a",
		});
		const real = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "tasks.focus", input: { id: task.id, session_id: "session-a", session_secret: secret } }),
		});
		expect(real.status).toBe(200);
		service.close();
	});

	it("provides a typed client over the same HTTP adapter", async () => {
		const { service, app } = fixture();
		const client = new PapyrusClient("http://papyrus.test", "test-token", (request) => app.fetch(request));
		expect(await client.health()).toEqual({
			ok: true,
			version: VERSION,
			schema: { current: 28, required: 28, migrationRequired: false },
		});
		await expect(client.diagnose()).rejects.toThrow("daemon diagnose is unavailable on this instance");
		const task = await client.call<{ title: string; project_root: string }, { id: string; kind: string }>("tasks.create", {
			title: "Client task",
			project_root: PROJECT_ROOT,
		});
		expect(task.kind).toBe("task");
		expect((await client.operations()).length).toBe(EXPECTED_OPERATION_NAMES.length);
		service.close();
	});

	it("fires onOperationExecuted only after a real success, carrying the exact operation name", async () => {
		const dir = tempDir("papyrus-service-hook-");
		const service = createPapyrusService(join(dir, "papyrus.db"));
		const executed: string[] = [];
		const app = createApp({ service, token: "test-token", onOperationExecuted: (operation) => executed.push(operation) });

		const created = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "tasks.create", input: { title: "Hook task", project_root: PROJECT_ROOT } }),
		});
		expect(created.status).toBe(200);

		// A failed operation (unknown op name) must not fire the hook -- a push consumer
		// would otherwise trigger a refresh for something that never actually mutated state.
		const failed = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "tasks.does_not_exist", input: {} }),
		});
		expect(failed.status).toBe(404);

		expect(executed).toEqual(["tasks.create"]);
		service.close();
	});

	it("GET /daemon/diagnose 404s when no diagnose callback is supplied -- most embedders (including this test's own fixture) don't run a real supervised daemon", async () => {
		const { service, app } = fixture();
		const response = await request(app, "/daemon/diagnose", { method: "GET" });
		expect(response.status).toBe(404);
		service.close();
	});

	it("GET /daemon/diagnose returns the supplied diagnose callback's result verbatim -- daemon.ts's real wiring point", async () => {
		const dir = tempDir("papyrus-service-diagnose-");
		const service = createPapyrusService(join(dir, "papyrus.db"));
		const diagnosis = {
			instanceId: "instance-1",
			pid: 4242,
			startedAt: "2026-01-01T00:00:00.000Z",
			provenance: "service" as const,
			history: [
				{ instanceId: "instance-0", pid: 1, type: "stopped" as const, at: "2025-12-31T00:00:00.000Z", provenance: "service" as const },
			],
		};
		const app = createApp({ service, token: "test-token", diagnose: () => Promise.resolve(diagnosis) });
		const response = await request(app, "/daemon/diagnose", { method: "GET" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(diagnosis);
		service.close();
	});

	it("PapyrusClient.diagnose() round-trips a real diagnosis through the same client every CLI command uses", async () => {
		const dir = tempDir("papyrus-service-client-diagnose-");
		const service = createPapyrusService(join(dir, "papyrus.db"));
		const diagnosis = {
			instanceId: "instance-2",
			pid: 555,
			startedAt: "2026-02-02T00:00:00.000Z",
			provenance: "auto-spawn" as const,
			history: [],
		};
		const app = createApp({ service, token: "test-token", diagnose: () => Promise.resolve(diagnosis) });
		const client = new PapyrusClient("http://papyrus.test", "test-token", (request) => app.fetch(request));
		expect(await client.diagnose()).toEqual(diagnosis);
		service.close();
	});

	it("GET /daemon/diagnose still requires the bearer token, exactly like every other route", async () => {
		const dir = tempDir("papyrus-service-diagnose-auth-");
		const service = createPapyrusService(join(dir, "papyrus.db"));
		const app = createApp({
			service,
			token: "test-token",
			diagnose: () => Promise.resolve({ instanceId: "i", pid: 1, startedAt: "now", provenance: "service" as const, history: [] }),
		});
		const response = await app.fetch(new Request("http://papyrus.test/daemon/diagnose"));
		expect(response.status).toBe(401);
		service.close();
	});
});

describe("graph.status refuses to bypass a kind's own validated lifecycle transitions, matching Tasks' existing protection", () => {
	it("refuses on a Doc: draft cannot jump straight to archived via the raw graph action", async () => {
		const { service } = fixture();
		const doc = (await service.execute("docs.create", { title: "Doc", actor: "agent" })) as { id: string; status: string };
		expect(doc.status).toBe("draft");
		await expect(service.execute("graph.status", { id: doc.id, status: "archived" })).rejects.toThrow("docs.* operation");
		expect(((await service.execute("docs.show", { id: doc.id })) as { status: string }).status).toBe("draft");
	});

	it("refuses on a Rule", async () => {
		const { service } = fixture();
		const rule = (await service.execute("rules.create", { title: "Rule", actor: "agent" })) as { id: string; status: string };
		expect(rule.status).toBe("active");
		await expect(service.execute("graph.status", { id: rule.id, status: "deprecated" })).rejects.toThrow("rules.* operation");
	});

	it("refuses on a Playbook", async () => {
		const { service } = fixture();
		const playbook = (await service.execute("playbooks.create", { title: "Playbook", actor: "agent" })) as { id: string; status: string };
		expect(playbook.status).toBe("active");
		await expect(service.execute("graph.status", { id: playbook.id, status: "deprecated" })).rejects.toThrow("playbooks.* operation");
	});

	it("still refuses on a Task, and on a Note -- the two kinds already protected before this fix", async () => {
		const { service } = fixture();
		const task = (await service.execute("tasks.create", { title: "Task", project_root: PROJECT_ROOT, actor: "agent" })) as { id: string };
		await expect(service.execute("graph.status", { id: task.id, status: "done" })).rejects.toThrow("tasks.* operation");
		const note = (await service.execute("notes.capture", { body: "Remember this", project_root: PROJECT_ROOT, actor: "agent" })) as {
			id: string;
		};
		await expect(service.execute("graph.status", { id: note.id, status: "active" })).rejects.toThrow("notes.* operation");
	});
});
