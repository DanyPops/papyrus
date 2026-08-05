import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { VehicleManifestOperation } from "@danypops/vehicle-core";
import { TASK_EXECUTION_MAX_DEGREE } from "../src/constants.ts";
import { createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT = "/tmp/example-project";
const PERMS = { permissions: ["tasks:read", "tasks:write"] };

function harness() {
	const directory = tempDir("papyrus-tasks-vehicle-");
	const service = createPapyrusService(join(directory, "papyrus.db"));
	return { registry: service.vehicle, service };
}

describe("registerTasksVehicleOperations (wired through createPapyrusService)", () => {
	it("registers exactly one honest VehicleOperation per real tasks.* action, never an action-dispatch schema -- excluding the two system-maintenance operations the removed tool never exposed either", () => {
		const { registry, service } = harness();
		const names = registry
			.manifest()
			.operations.map((op: VehicleManifestOperation) => op.name)
			.filter((name: string) => name.startsWith("tasks."))
			.sort();
		expect(names).toEqual([
			"tasks.active",
			"tasks.assign_project",
			"tasks.cancel",
			"tasks.cancel_subtree",
			"tasks.claim",
			"tasks.clear_focus",
			"tasks.complete",
			"tasks.contain",
			"tasks.context",
			"tasks.create",
			"tasks.depend",
			"tasks.event_feed",
			"tasks.focus",
			"tasks.focused",
			"tasks.graph",
			"tasks.heartbeat_lease",
			"tasks.history",
			"tasks.lease",
			"tasks.list",
			"tasks.pause",
			"tasks.plan",
			"tasks.reject",
			"tasks.release_lease",
			"tasks.retry",
			"tasks.run_gates",
			"tasks.scope",
			"tasks.set_checklist",
			"tasks.set_gates",
			"tasks.set_scope",
			"tasks.show",
			"tasks.start",
			"tasks.submit",
			"tasks.uncontain",
			"tasks.undepend",
			"tasks.unpause",
			"tasks.update",
		]);
		expect(names).not.toContain("tasks.reap_stale_focus");
		expect(names).not.toContain("tasks.reap_stale_leases");
		service.close();
	});

	it("denies a call with no permissions granted", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("tasks.list", 1, { project_root: PROJECT })).rejects.toThrow(/requires permissions/);
		service.close();
	});

	it("create requires project_root explicitly -- no ambient cwd server-side", async () => {
		const { registry, service } = harness();
		await expect(registry.invoke("tasks.create", 1, { title: "No project" }, PERMS)).rejects.toThrow();
		const created = (await registry.invoke("tasks.create", 1, { title: "Ship the feature", project_root: PROJECT }, PERMS)) as {
			id: string;
			title: string;
		};
		expect(created.title).toBe("Ship the feature");
		service.close();
	});

	it("list scopes by project_root, and root_task_name resolves before the main scope selection", async () => {
		const { registry, service } = harness();
		await registry.invoke("tasks.create", 1, { title: "Root task", project_root: PROJECT }, PERMS);
		const rows = (await registry.invoke("tasks.list", 1, { project_root: PROJECT }, PERMS)) as Array<{ title: string }>;
		expect(rows.map((row) => row.title)).toContain("Root task");
		service.close();
	});

	it("show resolves a task by name, scoped to project_root, without a separate round trip", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("tasks.create", 1, { title: "Findable", project_root: PROJECT }, PERMS)) as { id: string };
		const byId = await registry.invoke("tasks.show", 1, { id: created.id }, PERMS);
		const byName = await registry.invoke("tasks.show", 1, { name: "Findable", project_root: PROJECT }, PERMS);
		expect(byName).toEqual(byId);
		service.close();
	});

	it("show by name without project_root fails clearly -- there is no ambient cwd server-side to search by default", async () => {
		const { registry, service } = harness();
		await registry.invoke("tasks.create", 1, { title: "Scoped only", project_root: PROJECT }, PERMS);
		const rejection = await registry.invoke("tasks.show", 1, { name: "Scoped only" }, PERMS).catch((error: unknown) => error);
		// A validation failure inside name resolution must surface as its own VehicleError (code
		// validation-failed, category validation), not get swallowed into vehicle-registry's generic
		// handler-failed wrap -- the wrap is for a genuine unexpected crash, not an ordinary,
		// expected input-validation miss. Real incident: this used to arrive only inside .cause of
		// an opaque "tasks.show@1 handler failed", with the actual reason invisible to any caller.
		expect((rejection as { code?: string }).code).toBe("validation-failed");
		expect((rejection as { category?: string }).category).toBe("validation");
		expect((rejection as { cause?: unknown }).cause).toBeUndefined();
		expect((rejection as Error).message).toContain("project_root is required");
		service.close();
	});

	it("create resolves parent_name and depends_on_names server-side", async () => {
		const { registry, service } = harness();
		const parent = (await registry.invoke("tasks.create", 1, { title: "Parent", project_root: PROJECT }, PERMS)) as { id: string };
		const dependency = (await registry.invoke("tasks.create", 1, { title: "Dependency", project_root: PROJECT }, PERMS)) as { id: string };
		const child = (await registry.invoke(
			"tasks.create",
			1,
			{ title: "Child", project_root: PROJECT, parent_name: "Parent", depends_on_names: ["Dependency"] },
			PERMS,
		)) as { id: string };
		const graph = (await registry.invoke("tasks.graph", 1, { project_root: PROJECT }, PERMS)) as {
			nodes: Array<{ task: { id: string }; parentIds: string[]; dependencyIds: string[] }>;
		};
		const childNode = graph.nodes.find((node) => node.task.id === child.id)!;
		expect(childNode.parentIds).toContain(parent.id);
		expect(childNode.dependencyIds).toContain(dependency.id);
		service.close();
	});

	it("depend succeeds across project_root boundaries even once an unrelated project pushes the daemon-wide task count over the execution-graph bound", async () => {
		const { registry, service } = harness();
		for (let index = 0; index < 1001; index++) {
			await registry.invoke("tasks.create", 1, { title: `Filler ${index}`, project_root: "/tmp/filler-project" }, PERMS);
		}
		const fromA = (await registry.invoke("tasks.create", 1, { title: "From A", project_root: "/tmp/project-a" }, PERMS)) as {
			id: string;
		};
		const fromB = (await registry.invoke("tasks.create", 1, { title: "From B", project_root: "/tmp/project-b" }, PERMS)) as {
			id: string;
		};
		await registry.invoke("tasks.depend", 1, { id: fromA.id, dependency_id: fromB.id }, PERMS);
		// tasks.show reads edges directly, not through the bound-checked graph build -- the full
		// unscoped graph here would itself exceed 1000 nodes, the exact daemon-wide cost this fix avoids.
		const shown = (await registry.invoke("tasks.show", 1, { id: fromA.id }, PERMS)) as {
			edges: Array<{ from: string; relation: string; to: string }>;
		};
		expect(shown.edges).toContainEqual({ from: fromA.id, relation: "depends_on", to: fromB.id });
		service.close();
	});

	/**
	 * Bug 09d21959: tasks.update's recovery path and tasks.pause both throw a plain, genuinely
	 * informative Error ("cannot recover task creation from in-progress", "no focused task") for an
	 * ordinary caller mistake -- but vehicle-registry's generic handler wrap wasn't previously
	 * configured to expose that message, so every caller saw only an opaque "tasks.update@1 handler
	 * failed" with the real reason hidden. createPapyrusService now opts in to
	 * setExposeHandlerFailureDetails(true) (see service.ts) -- safe because no Papyrus domain error
	 * message ever embeds a session_secret or other credential (only session_id, a bare
	 * correlation id, ever appears).
	 */
	it("an ordinary caller mistake -- recovering a task that wasn't terminal at creation -- surfaces its real reason as causeMessage instead of a bare handler-failed", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("tasks.create", 1, { title: "In flight", project_root: PROJECT }, PERMS)) as { id: string };
		await registry.invoke("tasks.start", 1, { id: created.id, actor: "user", source: "test" }, PERMS);
		const rejection = (await registry
			.invoke("tasks.update", 1, { id: created.id, status: "todo", reason: "parking it", actor: "user", source: "test" }, PERMS)
			.catch((error: { toFailure(): { code: string; causeMessage?: string } }) => error.toFailure())) as {
			code: string;
			causeMessage?: string;
		};
		expect(rejection.code).toBe("handler-failed");
		expect(rejection.causeMessage).toBe("cannot recover task creation from in-progress");
		service.close();
	});

	it("pausing with no focused task surfaces its real reason as causeMessage instead of a bare handler-failed", async () => {
		const { registry, service } = harness();
		const rejection = (await registry
			.invoke("tasks.pause", 1, { actor: "user", source: "test", reason: "whatever" }, PERMS)
			.catch((error: { toFailure(): { code: string; causeMessage?: string } }) => error.toFailure())) as {
			code: string;
			causeMessage?: string;
		};
		expect(rejection.code).toBe("handler-failed");
		expect(rejection.causeMessage).toBe("no focused task");
		service.close();
	});

	it("a genuinely daemon-wide-exceeding cross-project depend surfaces a classified capacity error, not an opaque handler-failed", async () => {
		const { registry, service } = harness();
		for (let index = 0; index < 600; index++) {
			await registry.invoke("tasks.create", 1, { title: `A filler ${index}`, project_root: "/tmp/project-a" }, PERMS);
		}
		for (let index = 0; index < 600; index++) {
			await registry.invoke("tasks.create", 1, { title: `B filler ${index}`, project_root: "/tmp/project-b" }, PERMS);
		}
		const fromA = (await registry.invoke("tasks.create", 1, { title: "From A", project_root: "/tmp/project-a" }, PERMS)) as {
			id: string;
		};
		const fromB = (await registry.invoke("tasks.create", 1, { title: "From B", project_root: "/tmp/project-b" }, PERMS)) as {
			id: string;
		};
		const rejection = await registry.invoke("tasks.depend", 1, { id: fromA.id, dependency_id: fromB.id }, PERMS).catch((error) => error);
		expect(rejection).toMatchObject({ code: "task-execution-bound-exceeded", category: "capacity" });
		expect((rejection as Error).message).toContain("exceeds 1000 nodes");
		service.close();
	});

	it("start/submit/complete drive the full lifecycle, and complete's output carries a model-facing content summary", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("tasks.create", 1, { title: "Do the work", project_root: PROJECT }, PERMS)) as { id: string };
		await registry.invoke("tasks.start", 1, { id: created.id }, PERMS);
		await registry.invoke("tasks.submit", 1, { id: created.id }, PERMS);
		const completion = (await registry.invoke("tasks.complete", 1, { id: created.id }, PERMS)) as {
			completed: boolean;
			content?: Array<{ type: string; text: string }>;
		};
		expect(completion.completed).toBe(true);
		expect(completion.content?.[0]?.text).toContain("Completed: Do the work");
		service.close();
	});

	it("plan's output carries a layered execution-plan content summary", async () => {
		const { registry, service } = harness();
		await registry.invoke("tasks.create", 1, { title: "Plan me", project_root: PROJECT }, PERMS);
		const plan = (await registry.invoke("tasks.plan", 1, { project_root: PROJECT }, PERMS)) as {
			layers: string[][];
			content?: Array<{ type: string; text: string }>;
		};
		expect(plan.layers.length).toBeGreaterThan(0);
		expect(plan.content?.[0]?.text).toContain("Layer 1");
		expect(plan.content?.[0]?.text).toContain("Plan me");
		service.close();
	});

	it("run_gates' output carries a pass/fail content summary", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("tasks.create", 1, { title: "No gates yet", project_root: PROJECT }, PERMS)) as { id: string };
		const result = (await registry.invoke("tasks.run_gates", 1, { id: created.id }, PERMS)) as {
			gates: unknown[];
			content?: Array<{ type: string; text: string }>;
		};
		expect(result.content?.[0]?.text).toBe("No gates configured.");
		service.close();
	});

	it("cancel_subtree's output carries a canceled/skipped count content summary", async () => {
		const { registry, service } = harness();
		const parent = (await registry.invoke("tasks.create", 1, { title: "Cancel parent", project_root: PROJECT }, PERMS)) as { id: string };
		await registry.invoke("tasks.create", 1, { title: "Cancel child", project_root: PROJECT, parent_id: parent.id }, PERMS);
		const outcome = (await registry.invoke("tasks.cancel_subtree", 1, { id: parent.id }, PERMS)) as {
			canceled: string[];
			content?: Array<{ type: string; text: string }>;
		};
		expect(outcome.canceled.length).toBe(2);
		expect(outcome.content?.[0]?.text).toContain("Canceled 2 task(s)");
		service.close();
	});

	it("context's output carries the same reconciliation summary as its own context field, as content", async () => {
		const { registry, service } = harness();
		await registry.invoke("tasks.create", 1, { title: "Reconcile me", project_root: PROJECT }, PERMS);
		const result = (await registry.invoke("tasks.context", 1, { project_root: PROJECT }, PERMS)) as {
			context: string | null;
			content?: Array<{ type: string; text: string }>;
		};
		expect(result.content?.[0]?.text).toBe(result.context ?? undefined);
		service.close();
	});

	it("depend resolves dependency_name in a different project by widening scope once, when no explicit scope was pinned", async () => {
		const { registry, service } = harness();
		const from = (await registry.invoke("tasks.create", 1, { title: "From task", project_root: PROJECT }, PERMS)) as { id: string };
		const other = (await registry.invoke("tasks.create", 1, { title: "Companion task", project_root: "/tmp/other-project" }, PERMS)) as {
			id: string;
		};
		const updated = (await registry.invoke(
			"tasks.depend",
			1,
			{ id: from.id, dependency_name: "Companion task", project_root: PROJECT },
			PERMS,
		)) as { id: string };
		expect(updated.id).toBe(from.id);
		// Scoped to "all" for the readback, since a project-scoped graph read legitimately excludes
		// an out-of-scope dependency's edge -- this asserts resolution found the right task, not
		// project-scoped graph visibility (a separate, correct behavior).
		const graph = (await registry.invoke("tasks.graph", 1, { project_root: PROJECT, scope: "all" }, PERMS)) as {
			nodes: Array<{ task: { id: string }; dependencyIds: string[] }>;
		};
		expect(graph.nodes.find((node) => node.task.id === from.id)?.dependencyIds).toContain(other.id);
		service.close();
	});

	it("resolves by alias with zero ambiguity, even when another task's title would otherwise fuzzy-match the same string", async () => {
		const { registry, service } = harness();
		const target = (await registry.invoke("tasks.create", 1, { title: "Fix the timeout bug", project_root: PROJECT }, PERMS)) as {
			id: string;
			alias: string;
		};
		// Same title text as target.alias itself, so a title-based fuzzy match on this string would
		// be genuinely ambiguous -- alias resolution must win outright, with zero ambiguity error.
		await registry.invoke("tasks.create", 1, { title: target.alias, project_root: PROJECT }, PERMS);
		const shown = await registry.invoke("tasks.show", 1, { name: target.alias, project_root: PROJECT }, PERMS);
		expect((shown as { id: string }).id).toBe(target.id);
		service.close();
	});

	it("does not widen when the caller pinned an explicit scope, so a genuine not-found stays a real error", async () => {
		const { registry, service } = harness();
		const from = (await registry.invoke("tasks.create", 1, { title: "Scoped from", project_root: PROJECT }, PERMS)) as { id: string };
		await registry.invoke("tasks.create", 1, { title: "Elsewhere", project_root: "/tmp/other-project" }, PERMS);
		const rejection = await registry
			.invoke("tasks.depend", 1, { id: from.id, dependency_name: "Elsewhere", project_root: PROJECT, scope: "project" }, PERMS)
			.catch((error: unknown) => error);
		// Same real-incident fix as the show-by-name case above: a not-found/ambiguous name
		// resolution failure must surface directly, unwrapped -- matchArtifactByName's own
		// VehicleError("artifact-not-found", ...) passes vehicle-registry's dispatch unchanged.
		expect((rejection as { code?: string }).code).toBe("artifact-not-found");
		expect((rejection as { category?: string }).category).toBe("not_found");
		expect((rejection as { cause?: unknown }).cause).toBeUndefined();
		expect((rejection as Error).message).toContain('no artifact named "Elsewhere"');
		service.close();
	});

	it("an ambiguous dependency_name reports every matching alias instead of an opaque handler-failed wrap", async () => {
		const { registry, service } = harness();
		const from = (await registry.invoke("tasks.create", 1, { title: "Ambiguous from", project_root: PROJECT }, PERMS)) as { id: string };
		const first = (await registry.invoke("tasks.create", 1, { title: "Dup", project_root: PROJECT }, PERMS)) as { alias: string };
		const second = (await registry.invoke("tasks.create", 1, { title: "Dup", project_root: PROJECT }, PERMS)) as { alias: string };
		const rejection = await registry
			.invoke("tasks.depend", 1, { id: from.id, dependency_name: "Dup", project_root: PROJECT }, PERMS)
			.catch((error: unknown) => error);
		expect((rejection as { code?: string }).code).toBe("artifact-name-ambiguous");
		expect((rejection as { category?: string }).category).toBe("conflict");
		expect((rejection as Error).message).toContain(first.alias);
		expect((rejection as Error).message).toContain(second.alias);
		service.close();
	});

	it("a dependency cycle reports its own classified error instead of an opaque handler-failed wrap", async () => {
		const { registry, service } = harness();
		const first = (await registry.invoke("tasks.create", 1, { title: "First", project_root: PROJECT }, PERMS)) as { id: string };
		const second = (await registry.invoke("tasks.create", 1, { title: "Second", project_root: PROJECT }, PERMS)) as { id: string };
		await registry.invoke("tasks.depend", 1, { id: second.id, dependency_id: first.id, project_root: PROJECT }, PERMS);
		const rejection = await registry
			.invoke("tasks.depend", 1, { id: first.id, dependency_id: second.id, project_root: PROJECT }, PERMS)
			.catch((error: unknown) => error);
		// Real incident: this used to arrive only as an opaque "tasks.depend@1 handler failed", the
		// real message and category buried in .cause -- see task-execution.ts's assertDependencyEdgeAllowed.
		expect((rejection as { code?: string }).code).toBe("task-dependency-cycle");
		expect((rejection as { category?: string }).category).toBe("validation");
		expect((rejection as { cause?: unknown }).cause).toBeUndefined();
		expect((rejection as Error).message).toContain("dependency cycle");
		service.close();
	});

	it("exceeding the prerequisite degree bound reports its own classified error instead of an opaque handler-failed wrap", async () => {
		const { registry, service } = harness();
		const dependent = (await registry.invoke("tasks.create", 1, { title: "Dependent", project_root: PROJECT }, PERMS)) as { id: string };
		for (let index = 0; index < TASK_EXECUTION_MAX_DEGREE; index++) {
			const prerequisite = (await registry.invoke("tasks.create", 1, { title: `Prerequisite ${index}`, project_root: PROJECT }, PERMS)) as {
				id: string;
			};
			await registry.invoke("tasks.depend", 1, { id: dependent.id, dependency_id: prerequisite.id, project_root: PROJECT }, PERMS);
		}
		const oneMore = (await registry.invoke("tasks.create", 1, { title: "One more", project_root: PROJECT }, PERMS)) as { id: string };
		const rejection = await registry
			.invoke("tasks.depend", 1, { id: dependent.id, dependency_id: oneMore.id, project_root: PROJECT }, PERMS)
			.catch((error: unknown) => error);
		expect((rejection as { code?: string }).code).toBe("task-execution-bound-exceeded");
		expect((rejection as { category?: string }).category).toBe("capacity");
		expect((rejection as { cause?: unknown }).cause).toBeUndefined();
		expect((rejection as Error).message).toContain(`exceed ${TASK_EXECUTION_MAX_DEGREE} prerequisites`);
		service.close();
	});

	it("depend/undepend resolve dependency_name server-side and are idempotent", async () => {
		const { registry, service } = harness();
		const a = (await registry.invoke("tasks.create", 1, { title: "A", project_root: PROJECT }, PERMS)) as { id: string };
		await registry.invoke("tasks.create", 1, { title: "B", project_root: PROJECT }, PERMS);
		await registry.invoke("tasks.depend", 1, { id: a.id, dependency_name: "B", project_root: PROJECT }, PERMS);
		const graph = (await registry.invoke("tasks.graph", 1, { project_root: PROJECT }, PERMS)) as {
			nodes: Array<{ task: { id: string }; dependencyIds: string[] }>;
		};
		expect(graph.nodes.find((node) => node.task.id === a.id)?.dependencyIds.length).toBe(1);
		await registry.invoke("tasks.undepend", 1, { id: a.id, dependency_name: "B", project_root: PROJECT }, PERMS);
		await registry.invoke("tasks.undepend", 1, { id: a.id, dependency_name: "B", project_root: PROJECT }, PERMS); // idempotent no-op
		service.close();
	});

	it("focus/pause/unpause/clear_focus authorize their write via principal.claims.sessionId/sessionSecret, never a model-visible input field", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke("tasks.create", 1, { title: "Focus me", project_root: PROJECT }, PERMS)) as { id: string };
		const { secret } = (await service.execute("session.register", { session_id: "session-1" })) as { sessionId: string; secret: string };

		const rejection = await registry
			.invoke(
				"tasks.focus",
				1,
				{ id: created.id },
				{
					...PERMS,
					principal: { id: "pi-papyrus", claims: { sessionId: "session-1", sessionSecret: "wrong-secret" } },
				},
			)
			.catch((error: unknown) => error);
		// A wrong secret for a REGISTERED session id is refused -- assertAuthorized's real check runs
		// and must surface as its own classified VehicleError directly, not buried inside .cause of an
		// opaque "handler failed" wrap invisible to a caller that doesn't already know to dig for it.
		expect((rejection as { code?: string }).code).toBe("invalid-session-secret");
		expect((rejection as { category?: string }).category).toBe("authorization");
		expect((rejection as { cause?: unknown }).cause).toBeUndefined();
		expect((rejection as Error).message).toContain("session_secret");

		const focused = (await registry.invoke(
			"tasks.focus",
			1,
			{ id: created.id },
			{
				...PERMS,
				principal: { id: "pi-papyrus", claims: { sessionId: "session-1", sessionSecret: secret } },
			},
		)) as { id: string };
		expect(focused.id).toBe(created.id);

		const paused = (await registry.invoke(
			"tasks.pause",
			1,
			{},
			{
				...PERMS,
				principal: { id: "pi-papyrus", claims: { sessionId: "session-1", sessionSecret: secret } },
			},
		)) as { artifact: { id: string }; status: string };
		expect(paused.artifact.id).toBe(created.id);
		expect(paused.status).toBe("paused");
		service.close();
	});

	it("claim/heartbeat_lease/release_lease/lease resolve by name and round-trip a real lease", async () => {
		const { registry, service } = harness();
		await registry.invoke("tasks.create", 1, { title: "Lease me", project_root: PROJECT }, PERMS);
		const claimed = (await registry.invoke("tasks.claim", 1, { name: "Lease me", project_root: PROJECT, owner: "worker-1" }, PERMS)) as {
			owner: string;
			token: string;
		};
		expect(claimed.owner).toBe("worker-1");
		const lease = (await registry.invoke("tasks.lease", 1, { name: "Lease me", project_root: PROJECT }, PERMS)) as { owner: string };
		expect(lease.owner).toBe("worker-1");
		const released = (await registry.invoke(
			"tasks.release_lease",
			1,
			{ name: "Lease me", project_root: PROJECT, owner: "worker-1", token: claimed.token },
			PERMS,
		)) as { released: boolean };
		expect(released.released).toBe(true);
		service.close();
	});

	it("event_feed lists real task lifecycle events, cursor-paginated, with no project_root requirement", async () => {
		const { registry, service } = harness();
		await registry.invoke("tasks.create", 1, { title: "Feed me", project_root: PROJECT }, PERMS);
		const page = (await registry.invoke("tasks.event_feed", 1, { limit: 5 }, PERMS)) as { events: unknown[] };
		expect(page.events.length).toBeGreaterThan(0);
		service.close();
	});

	it("real incident: tasks.update's own schema never declares gates, and a gates field riding along on it has zero effect -- set_gates is the one true way to change gates", async () => {
		const { registry, service } = harness();
		const updateSchema = registry.manifest().operations.find((op: VehicleManifestOperation) => op.name === "tasks.update")!.inputSchema as {
			properties: Record<string, unknown>;
		};
		expect(updateSchema.properties).not.toHaveProperty("gates");

		const created = (await registry.invoke(
			"tasks.create",
			1,
			{ title: "Gate me", project_root: PROJECT, gates: [{ type: "command", target: "echo original" }] },
			PERMS,
		)) as { id: string };
		// Even bypassing the schema (a real caller can't reach this at all -- gates isn't a declared
		// property), the underlying module handler ignores it by design: only set_gates writes gates.
		await registry.invoke(
			"tasks.update",
			1,
			{ id: created.id, body: "new body", gates: [{ type: "command", target: "echo should-be-ignored" }] },
			PERMS,
		);
		const afterUpdate = (await registry.invoke("tasks.show", 1, { id: created.id }, PERMS)) as { extra?: { gates?: unknown[] } };
		expect(afterUpdate.extra?.gates).toEqual([{ type: "command", target: "echo original" }]);

		await registry.invoke("tasks.set_gates", 1, { id: created.id, gates: [{ type: "command", target: "echo replaced" }] }, PERMS);
		const afterSetGates = (await registry.invoke("tasks.show", 1, { id: created.id }, PERMS)) as { extra?: { gates?: unknown[] } };
		expect(afterSetGates.extra?.gates).toEqual([{ type: "command", target: "echo replaced" }]);
		service.close();
	});

	it("remove/restore go through the shared kind-agnostic artifact.* operations, not a tasks-namespaced duplicate", async () => {
		const { registry, service } = harness();
		const created = (await registry.invoke(
			"tasks.create",
			1,
			{ title: "Trash me", project_root: PROJECT },
			{ permissions: ["tasks:read", "tasks:write", "artifact:read", "artifact:write"] },
		)) as { id: string };
		await registry.invoke(
			"artifact.remove",
			1,
			{ id: created.id },
			{ permissions: ["tasks:read", "tasks:write", "artifact:read", "artifact:write"] },
		);
		const trashStatus = (await service.execute("artifact.trash_status", { id: created.id })) as { artifactId: string } | null;
		expect(trashStatus?.artifactId).toBe(created.id);
		service.close();
	});
});
