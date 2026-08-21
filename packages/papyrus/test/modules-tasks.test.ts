import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { SQLiteGateRunner } from "../src/gate/sqlite-gate-runner.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { TASKS_OPERATION_NAMES, tasksOperations } from "../src/modules/tasks.ts";
import { SessionIdentity } from "../src/session-identity/session-identity-service.ts";
import { SQLiteSessionIdentityStore } from "../src/session-identity/sqlite-session-identity-store.ts";
import { SQLiteTaskEventStore } from "../src/task/event/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/task/focus/sqlite-task-focus-store.ts";
import { SQLiteTaskLeaseStore } from "../src/task/lease/sqlite-task-lease-store.ts";
import { SQLiteTaskScopeStore } from "../src/task/scope/sqlite-task-scope-store.ts";
import { Tasks } from "../src/task/task-service.ts";

const PROJECT_ROOT = "/workspace/papyrus";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const gates = new SQLiteGateRunner(db);
	const tasks = new Tasks(
		artifacts,
		gates,
		new SQLiteTaskFocusStore(db),
		new SQLiteTaskEventStore(db),
		new SQLiteTaskScopeStore(db),
		new SQLiteTaskLeaseStore(db),
	);
	const sessionIdentity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
	const registry = new OperationRegistry();
	registry.registerAll(tasksOperations(tasks, artifacts, sessionIdentity));
	return { registry, tasks, sessionIdentity };
}

describe("modules/tasks — the second Papyrus-native registered module", () => {
	it("registers exactly the tasks.* operations EXPECTED_OPERATION_NAMES declares, no more, no fewer", () => {
		const { registry } = fixture();
		expect(registry.list()).toEqual([...TASKS_OPERATION_NAMES].sort());
	});

	it("each registered operation is owned by the tasks module", () => {
		const { registry } = fixture();
		for (const name of registry.list()) {
			expect(registry.get(name)?.moduleId).toBe("tasks");
		}
	});

	it("delegates create/list/show/lifecycle operations to the real Tasks instance with the same field mapping as the prior inline handlers", async () => {
		const { registry } = fixture();
		const created = (await registry.get("tasks.create")!.execute({ title: "First task", project_root: PROJECT_ROOT })) as {
			id: string;
			status: string;
		};
		expect(created.status).toBe("todo");

		const listed = (await registry.get("tasks.list")!.execute({ project_root: PROJECT_ROOT })) as Array<{ id: string }>;
		expect(listed.map((t) => t.id)).toContain(created.id);
		expect(Array.isArray(listed)).toBe(true);

		const page = (await registry.get("tasks.list_page")!.execute({ project_root: PROJECT_ROOT, limit: 1 })) as {
			items: Array<{ id: string }>;
		};
		expect(page.items.map((task) => task.id)).toContain(created.id);

		const shown = (await registry.get("tasks.show")!.execute({ id: created.id })) as { id: string };
		expect(shown.id).toBe(created.id);

		const started = (await registry.get("tasks.start")!.execute({ id: created.id })) as { status: string };
		expect(started.status).toBe("in-progress");

		const focused = (await registry.get("tasks.focused")!.execute({ project_root: PROJECT_ROOT })) as { artifact: { id: string } } | null;
		expect(focused?.artifact.id).toBe(created.id);
	});

	it("tasks.context assembles from the same shared ArtifactStore port the composition root passes in, not a Tasks-internal copy", async () => {
		const { registry } = fixture();
		await registry.get("tasks.create")!.execute({ title: "Context task", project_root: PROJECT_ROOT });
		const summary = (await registry.get("tasks.context")!.execute({ project_root: PROJECT_ROOT })) as string | null;
		expect(summary).toContain("Context task");
	});

	it("tasks.context verbosity=summary renders a lean pointer for the current task; anything else (including omitted) renders the full plan", async () => {
		const { registry } = fixture();
		const task = (await registry
			.get("tasks.create")!
			.execute({ title: "Context task", body: "Full desired state prose", project_root: PROJECT_ROOT })) as { id: string };
		await registry.get("tasks.start")!.execute({ id: task.id });
		const summary = (await registry.get("tasks.context")!.execute({ project_root: PROJECT_ROOT, verbosity: "summary" })) as string;
		expect(summary).toContain("Current: Context task [in-progress]");
		expect(summary).not.toContain("Full desired state prose");
		const full = (await registry.get("tasks.context")!.execute({ project_root: PROJECT_ROOT })) as string;
		expect(full).toContain("Desired: Full desired state prose");
	});

	it("dependency and containment operations still enforce Task-domain invariants unchanged", async () => {
		const { registry } = fixture();
		const a = (await registry.get("tasks.create")!.execute({ title: "A", project_root: PROJECT_ROOT })) as { id: string };
		const b = (await registry.get("tasks.create")!.execute({ title: "B", project_root: PROJECT_ROOT })) as { id: string };
		await registry.get("tasks.depend")!.execute({ id: a.id, dependency_id: b.id });
		const graph = (await registry.get("tasks.graph")!.execute({ project_root: PROJECT_ROOT })) as {
			nodes: Array<{ task: { id: string }; dependencyIds: string[] }>;
		};
		expect(graph.nodes.find((n) => n.task.id === a.id)?.dependencyIds).toEqual([b.id]);

		await registry.get("tasks.undepend")!.execute({ id: a.id, dependency_id: b.id });
		const graphAfter = (await registry.get("tasks.graph")!.execute({ project_root: PROJECT_ROOT })) as {
			nodes: Array<{ task: { id: string }; dependencyIds: string[] }>;
		};
		expect(graphAfter.nodes.find((n) => n.task.id === a.id)?.dependencyIds).toEqual([]);
	});

	it("tasks.cancel_subtree cancels a whole containment tree via the registered operation, not just the direct task", async () => {
		const { registry } = fixture();
		const root = (await registry.get("tasks.create")!.execute({ title: "Root", project_root: PROJECT_ROOT })) as { id: string };
		const child = (await registry.get("tasks.create")!.execute({ title: "Child", project_root: PROJECT_ROOT })) as { id: string };
		await registry.get("tasks.contain")!.execute({ parent_id: root.id, child_id: child.id });

		const outcome = (await registry.get("tasks.cancel_subtree")!.execute({ id: root.id })) as { canceled: string[]; skipped: string[] };
		expect(outcome.canceled.sort()).toEqual([root.id, child.id].sort());
		const rootShown = (await registry.get("tasks.show")!.execute({ id: root.id })) as { status: string };
		const childShown = (await registry.get("tasks.show")!.execute({ id: child.id })) as { status: string };
		expect(rootShown.status).toBe("canceled");
		expect(childShown.status).toBe("canceled");
	});

	it("rejects a request missing a required field, matching the prior inline handler's validation", () => {
		const { registry } = fixture();
		expect(() => registry.get("tasks.create")!.execute({ project_root: PROJECT_ROOT })).toThrow("title is required");
	});

	it("tasks.reap_stale_focus delegates to Tasks.reapStaleFocus and reports how many rows were removed", () => {
		const { registry } = fixture();
		const result = registry.get("tasks.reap_stale_focus")!.execute({}) as { removed: number };
		expect(result).toEqual({ removed: 0 });
	});

	describe("lease operations", () => {
		it("claims, heartbeats, releases, and reads a lease through the real operation handlers", async () => {
			const { registry, tasks } = fixture();
			const task = tasks.create({ title: "Ready work", projectRoot: PROJECT_ROOT });
			const claimed = (await registry.get("tasks.claim")!.execute({ id: task.id, owner: "worker-a", ttl_ms: 60_000 })) as {
				taskName: string;
				taskTitle: string;
				owner: string;
				token: string;
			};
			expect(claimed).toMatchObject({ taskName: task.alias, taskTitle: "Ready work", owner: "worker-a" });
			expect(claimed).not.toHaveProperty("taskId");

			const renewed = (await registry
				.get("tasks.heartbeat_lease")!
				.execute({ id: task.id, owner: "worker-a", token: claimed.token, ttl_ms: 120_000 })) as { token: string };
			expect(renewed.token).toBe(claimed.token);

			const read = (await registry.get("tasks.lease")!.execute({ id: task.id })) as { owner: string } | null;
			expect(read?.owner).toBe("worker-a");

			const released = (await registry.get("tasks.release_lease")!.execute({ id: task.id, owner: "worker-a", token: claimed.token })) as {
				released: boolean;
			};
			expect(released).toEqual({ released: true });
			expect(await registry.get("tasks.lease")!.execute({ id: task.id })).toBeNull();
		});

		it("tasks.reap_stale_leases delegates to Tasks.reapStaleLeases and reports how many rows were removed", () => {
			const { registry } = fixture();
			const result = registry.get("tasks.reap_stale_leases")!.execute({}) as { removed: number };
			expect(result).toEqual({ removed: 0 });
		});

		it("rejects a claim missing owner, matching every other required-field validation", () => {
			const { registry, tasks } = fixture();
			const task = tasks.create({ title: "Ready work", projectRoot: PROJECT_ROOT });
			expect(() => registry.get("tasks.claim")!.execute({ id: task.id })).toThrow("owner is required");
		});
	});

	describe("tasks.event_feed", () => {
		it("replays events globally, filterable by type, through the real operation handler", async () => {
			const { registry, tasks } = fixture();
			const root = tasks.create({ title: "Root", status: "review", projectRoot: PROJECT_ROOT });
			tasks.create({ title: "Successor", dependsOn: [root.id], projectRoot: PROJECT_ROOT });
			tasks.complete(root.id);
			const page = (await registry.get("tasks.event_feed")!.execute({ event_types: ["became_ready"] })) as {
				events: Array<{ type: string }>;
			};
			expect(page.events.map((event) => event.type)).toEqual(["became_ready"]);
		});
	});

	describe("session-identity enforcement on Focus-mutating operations", () => {
		it("an unregistered session_id (including undefined, the 'global' scope) mutates Focus exactly as before -- opt-in armor", () => {
			const { registry } = fixture();
			const task = registry.get("tasks.create")!.execute({ title: "T", project_root: PROJECT_ROOT }) as { id: string };
			expect(registry.get("tasks.focus")!.execute({ id: task.id })).toBeTruthy();
			expect(registry.get("tasks.pause")!.execute({})).toBeTruthy();
			expect(registry.get("tasks.unpause")!.execute({})).toBeTruthy();
			expect(registry.get("tasks.clear_focus")!.execute({})).toBeTruthy();

			const taskB = registry.get("tasks.create")!.execute({ title: "T2", project_root: PROJECT_ROOT }) as { id: string };
			expect(registry.get("tasks.focus")!.execute({ id: taskB.id, session_id: "never-registered" })).toBeTruthy();
		});

		it("once a session_id is registered, mutating ITS Focus without the matching secret is rejected", () => {
			const { registry, sessionIdentity } = fixture();
			const task = registry.get("tasks.create")!.execute({ title: "T", project_root: PROJECT_ROOT }) as { id: string };
			const { secret } = sessionIdentity.register("session-a");

			expect(() => registry.get("tasks.focus")!.execute({ id: task.id, session_id: "session-a" })).toThrow(/session_secret/);
			expect(() => registry.get("tasks.focus")!.execute({ id: task.id, session_id: "session-a", session_secret: "wrong" })).toThrow(
				/session_secret/,
			);
			expect(registry.get("tasks.focus")!.execute({ id: task.id, session_id: "session-a", session_secret: secret })).toBeTruthy();

			expect(() => registry.get("tasks.pause")!.execute({ session_id: "session-a" })).toThrow(/session_secret/);
			expect(registry.get("tasks.pause")!.execute({ session_id: "session-a", session_secret: secret })).toBeTruthy();
			expect(() => registry.get("tasks.unpause")!.execute({ session_id: "session-a" })).toThrow(/session_secret/);
			expect(registry.get("tasks.unpause")!.execute({ session_id: "session-a", session_secret: secret })).toBeTruthy();
			expect(() => registry.get("tasks.clear_focus")!.execute({ session_id: "session-a" })).toThrow(/session_secret/);
			expect(registry.get("tasks.clear_focus")!.execute({ session_id: "session-a", session_secret: secret })).toBeTruthy();
		});

		it("two different registered sessions cannot hijack each other's Focus, even with a real (but wrong) secret", () => {
			const { registry, sessionIdentity } = fixture();
			const taskA = registry.get("tasks.create")!.execute({ title: "A", project_root: PROJECT_ROOT }) as { id: string };
			const a = sessionIdentity.register("session-a");
			const b = sessionIdentity.register("session-b");

			expect(() => registry.get("tasks.focus")!.execute({ id: taskA.id, session_id: "session-a", session_secret: b.secret })).toThrow(
				/session_secret/,
			);
			expect(registry.get("tasks.focus")!.execute({ id: taskA.id, session_id: "session-a", session_secret: a.secret })).toBeTruthy();
		});
	});

	it("tasks.list and tasks.graph filter by label through the real operation handler, not just the Tasks service directly", async () => {
		const { registry } = fixture();
		await registry.get("tasks.create")!.execute({ title: "Urgent", project_root: PROJECT_ROOT, labels: ["urgent"] });
		await registry.get("tasks.create")!.execute({ title: "Not urgent", project_root: PROJECT_ROOT });

		const listed = (await registry.get("tasks.list")!.execute({ project_root: PROJECT_ROOT, labels: ["urgent"] })) as Array<{
			title: string;
		}>;
		expect(listed.map((task) => task.title)).toEqual(["Urgent"]);

		const graph = (await registry.get("tasks.graph")!.execute({ project_root: PROJECT_ROOT, labels: ["urgent"] })) as {
			nodes: Array<{ task: { title: string } }>;
		};
		expect(graph.nodes.map((node) => node.task.title)).toEqual(["Urgent"]);
	});
});
