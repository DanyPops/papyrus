import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { SQLiteTaskEventStore } from "../src/adapters/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { createPapyrusService } from "../src/service.ts";
import { Tasks } from "../src/task-service.ts";

const PROJECT_ROOT = "/workspace/papyrus";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const gates = new SQLiteGateRunner(db);
	const events = new SQLiteTaskEventStore(db);
	const tasks = new Tasks(artifacts, gates, new SQLiteTaskFocusStore(db), events);
	return { db, artifacts, tasks, events };
}

describe("generic relationship removal — ArtifactStore.unlink", () => {
	it("removes an existing edge and records an append-only unlinked event", () => {
		const { artifacts } = fixture();
		const from = artifacts.create({ kind: "doc", title: "From" });
		const to = artifacts.create({ kind: "doc", title: "To" });
		artifacts.link({ from: from.id, relation: "relates_to", to: to.id });

		const removed = artifacts.unlink({ from: from.id, relation: "relates_to", to: to.id }, { actor: "agent" });
		expect(removed).toBe(true);

		const events = artifacts.events({ artifactId: from.id, direction: "asc" }).events;
		expect(events.map((e) => e.type)).toEqual(["created", "linked", "unlinked"]);
		expect(events.at(-1)?.actor).toBe("agent");
		expect(events.at(-1)?.relation).toBe("relates_to");
		expect(events.at(-1)?.relatedId).toBe(to.id);
	});

	it("is idempotent for an already-absent relationship: no error, no event, returns false", () => {
		const { artifacts } = fixture();
		const from = artifacts.create({ kind: "doc", title: "From" });
		const to = artifacts.create({ kind: "doc", title: "To" });

		const removed = artifacts.unlink({ from: from.id, relation: "relates_to", to: to.id });
		expect(removed).toBe(false);
		expect(artifacts.events({ artifactId: from.id }).events.map((e) => e.type)).toEqual(["created"]);
	});

	it("does not remove an edge with the same endpoints but a different relation", () => {
		const { artifacts } = fixture();
		const from = artifacts.create({ kind: "doc", title: "From" });
		const to = artifacts.create({ kind: "doc", title: "To" });
		artifacts.link({ from: from.id, relation: "references", to: to.id });

		expect(artifacts.unlink({ from: from.id, relation: "relates_to", to: to.id })).toBe(false);
		expect(artifacts.relationships({ artifactIds: [from.id] })).toEqual([{ from: from.id, relation: "references", to: to.id }]);
	});
});

describe("Task dependency removal — undepend", () => {
	it("removes a dependency and returns the task without starting, completing, or focusing anything", () => {
		const { tasks } = fixture();
		const a = tasks.create({ title: "A" });
		const b = tasks.create({ title: "B" });
		tasks.depend(a.id, b.id);

		const result = tasks.undepend(a.id, b.id, { actor: "agent", reason: "no longer needed" });
		expect(result.id).toBe(a.id);
		expect(tasks.graph().nodes.find((n) => n.task.id === a.id)?.dependencyIds).toEqual([]);
		expect(tasks.focused()).toBeNull(); // nothing was auto-focused
		expect(tasks.show(a.id).status).toBe("todo"); // nothing was auto-started
	});

	it("is idempotent when the dependency does not exist, but still validates both endpoints exist", () => {
		const { tasks } = fixture();
		const a = tasks.create({ title: "A" });
		const b = tasks.create({ title: "B" });

		expect(tasks.undepend(a.id, b.id).id).toBe(a.id); // no-op, no throw
		expect(() => tasks.undepend(a.id, "missing")).toThrow('task artifact "missing" not found');
		expect(() => tasks.undepend("missing", b.id)).toThrow('task artifact "missing" not found');
	});

	it("records append-only dependency_added and dependency_removed Task events with actor/source/reason", () => {
		const { tasks } = fixture();
		const a = tasks.create({ title: "A" });
		const b = tasks.create({ title: "B" });
		tasks.depend(a.id, b.id, { actor: "agent-a", source: "test" });
		tasks.undepend(a.id, b.id, { actor: "agent-b", source: "test", reason: "descoped" });

		const history = tasks.history(a.id, { direction: "asc" }).events;
		const added = history.find((e) => e.type === "dependency_added");
		const removed = history.find((e) => e.type === "dependency_removed");
		expect(added?.actor).toBe("agent-a");
		expect(removed).toEqual(expect.objectContaining({ actor: "agent-b", reason: "descoped" }));
	});

	it("does not duplicate dependency_added history when depend is called twice (idempotent create)", () => {
		const { tasks } = fixture();
		const a = tasks.create({ title: "A" });
		const b = tasks.create({ title: "B" });
		tasks.depend(a.id, b.id);
		tasks.depend(a.id, b.id);
		const added = tasks.history(a.id).events.filter((e) => e.type === "dependency_added");
		expect(added.length).toBe(1);
	});
});

describe("Task dependency removal — fan-in/fan-out readiness", () => {
	it("removing one of several prerequisites (fan-in) leaves the others blocking", () => {
		const { tasks } = fixture();
		const target = tasks.create({ title: "Target" });
		const depA = tasks.create({ title: "Dep A" });
		const depB = tasks.create({ title: "Dep B" });
		tasks.depend(target.id, depA.id);
		tasks.depend(target.id, depB.id);

		tasks.undepend(target.id, depA.id);

		const node = tasks.graph().nodes.find((n) => n.task.id === target.id);
		expect(node?.dependencyIds).toEqual([depB.id]);
		expect(() => tasks.transition(target.id, "start")).toThrow(/blocked by dependencies/);
	});

	it("removing the last prerequisite (fan-out) unblocks the dependent without auto-starting it", () => {
		const { tasks } = fixture();
		const target = tasks.create({ title: "Target" });
		const depA = tasks.create({ title: "Dep A" });
		tasks.depend(target.id, depA.id);

		tasks.undepend(target.id, depA.id);

		expect(tasks.graph().nodes.find((n) => n.task.id === target.id)?.dependencyIds).toEqual([]);
		expect(tasks.show(target.id).status).toBe("todo"); // unblocked, but not auto-started
		expect(() => tasks.transition(target.id, "start")).not.toThrow();
	});

	it("removing one dependent from a shared prerequisite (fan-out on the other side) leaves the remaining dependent blocked", () => {
		const { tasks } = fixture();
		const prerequisite = tasks.create({ title: "Prerequisite" });
		const dependentA = tasks.create({ title: "Dependent A" });
		const dependentB = tasks.create({ title: "Dependent B" });
		tasks.depend(dependentA.id, prerequisite.id);
		tasks.depend(dependentB.id, prerequisite.id);

		tasks.undepend(dependentA.id, prerequisite.id);

		expect(() => tasks.transition(dependentA.id, "start")).not.toThrow();
		expect(() => tasks.transition(dependentB.id, "start")).toThrow(/blocked by dependencies/);
	});
});

describe("Relationship removal on terminal Tasks", () => {
	it("undepend on a done or canceled task still removes the edge without reviving lifecycle state", () => {
		const { tasks } = fixture();
		const target = tasks.create({ title: "Target" });
		const dep = tasks.create({ title: "Dep" });
		tasks.depend(target.id, dep.id);
		tasks.transition(target.id, "cancel");

		const result = tasks.undepend(target.id, dep.id);
		expect(result.status).toBe("canceled"); // removal never revives lifecycle state
		expect(tasks.graph().nodes.find((n) => n.task.id === target.id)?.dependencyIds).toEqual([]);
	});

	it("uncontain on a done or canceled child still removes the containment edges", () => {
		const { tasks } = fixture();
		const parent = tasks.create({ title: "Parent" });
		const child = tasks.create({ title: "Child" });
		tasks.contain(parent.id, child.id);
		tasks.transition(child.id, "cancel");

		const result = tasks.uncontain(parent.id, child.id);
		expect(result.id).toBe(parent.id);
		expect(tasks.graph().nodes.find((n) => n.task.id === parent.id)?.childIds).toEqual([]);
	});
});

describe("cross-project Task dependency and containment edges are allowed by design", () => {
	// See decision-task-dependency-and-containment-edges-may-cross-pro-ysns: project_root is a
	// personal default-view filter, not a multi-tenancy boundary, so linking across projects is
	// intentionally unrestricted. This test locks that decision in against silent regression.
	it("allows creating and removing a dependency between Tasks in different projects", () => {
		const { tasks } = fixture();
		const a = tasks.create({ title: "A", projectRoot: "/repo/one", projectSource: "explicit" });
		const b = tasks.create({ title: "B", projectRoot: "/repo/two", projectSource: "explicit" });

		expect(() => tasks.depend(a.id, b.id)).not.toThrow();
		expect(tasks.graph().nodes.find((n) => n.task.id === a.id)?.dependencyIds).toEqual([b.id]);

		expect(() => tasks.undepend(a.id, b.id)).not.toThrow();
		expect(tasks.graph().nodes.find((n) => n.task.id === a.id)?.dependencyIds).toEqual([]);
	});

	it("allows creating and removing containment between Tasks in different projects", () => {
		const { tasks } = fixture();
		const parent = tasks.create({ title: "Parent", projectRoot: "/repo/one", projectSource: "explicit" });
		const child = tasks.create({ title: "Child", projectRoot: "/repo/two", projectSource: "explicit" });

		expect(() => tasks.contain(parent.id, child.id)).not.toThrow();
		expect(tasks.graph().nodes.find((n) => n.task.id === parent.id)?.childIds).toEqual([child.id]);

		expect(() => tasks.uncontain(parent.id, child.id)).not.toThrow();
	});

	it("a project-scoped list excludes the cross-project counterpart, but scope=all still shows both", () => {
		const { tasks } = fixture();
		const a = tasks.create({ title: "A", projectRoot: "/repo/one", projectSource: "explicit" });
		const b = tasks.create({ title: "B", projectRoot: "/repo/two", projectSource: "explicit" });
		tasks.depend(a.id, b.id);

		const scopedToOne = tasks.list({ projectRoot: "/repo/one" }).map((t) => t.id);
		expect(scopedToOne).toContain(a.id);
		expect(scopedToOne).not.toContain(b.id);

		const all = tasks.list({ projectRoot: "/repo/one", scope: "all" }).map((t) => t.id);
		expect(all).toContain(a.id);
		expect(all).toContain(b.id);
	});
});

describe("graph.link/graph.unlink preserve Note lifecycle protections", () => {
	it("rejects linking or unlinking a Note through the low-level graph operations", async () => {
		const service = createPapyrusService(":memory:");
		const note = await service.execute("notes.capture", { body: "a deferred idea", project_root: PROJECT_ROOT }) as { id: string };
		const doc = await service.execute("docs.create", { title: "Unrelated doc" }) as { id: string };

		await expect(service.execute("graph.link", { from: note.id, relation: "relates_to", to: doc.id }))
			.rejects.toThrow("note relationships require a notes.* operation");
		await expect(service.execute("graph.link", { from: doc.id, relation: "relates_to", to: note.id }))
			.rejects.toThrow("note relationships require a notes.* operation");
		await expect(service.execute("graph.unlink", { from: note.id, relation: "relates_to", to: doc.id }))
			.rejects.toThrow("note relationships require a notes.* operation");
		service.close();
	});

	it("still allows notes.promote to create its own relates_to edge internally", async () => {
		const service = createPapyrusService(":memory:");
		const note = await service.execute("notes.capture", { body: "a deferred idea", project_root: PROJECT_ROOT }) as { id: string };
		const doc = await service.execute("docs.create", { title: "Target doc" }) as { id: string };

		const promoted = await service.execute("notes.promote", { id: note.id, target_id: doc.id, project_root: PROJECT_ROOT }) as { status: string };
		expect(promoted.status).toBe("archived");
		service.close();
	});
});

describe("Task containment removal — uncontain", () => {
	it("removes both contains and part_of edges atomically", () => {
		const { tasks } = fixture();
		const parent = tasks.create({ title: "Parent" });
		const child = tasks.create({ title: "Child" });
		tasks.contain(parent.id, child.id);

		tasks.uncontain(parent.id, child.id, { actor: "agent" });

		const parentGraph = tasks.graph().nodes.find((n) => n.task.id === parent.id);
		const childGraph = tasks.graph().nodes.find((n) => n.task.id === child.id);
		expect(parentGraph?.childIds).toEqual([]);
		expect(childGraph?.parentIds).toEqual([]);
	});

	it("is idempotent when the containment does not exist, but still validates both endpoints exist", () => {
		const { tasks } = fixture();
		const parent = tasks.create({ title: "Parent" });
		const child = tasks.create({ title: "Child" });

		expect(tasks.uncontain(parent.id, child.id).id).toBe(parent.id); // no-op
		expect(() => tasks.uncontain(parent.id, "missing")).toThrow('task artifact "missing" not found');
	});

	it("records append-only containment_added and containment_removed Task events", () => {
		const { tasks } = fixture();
		const parent = tasks.create({ title: "Parent" });
		const child = tasks.create({ title: "Child" });
		tasks.contain(parent.id, child.id, { actor: "agent-a" });
		tasks.uncontain(parent.id, child.id, { actor: "agent-b", reason: "reorganized" });

		const history = tasks.history(parent.id, { direction: "asc" }).events;
		expect(history.map((e) => e.type)).toContain("containment_added");
		expect(history.map((e) => e.type)).toContain("containment_removed");
		expect(history.find((e) => e.type === "containment_removed")?.reason).toBe("reorganized");
	});

	it("leaves both containment directions intact if the transaction rolls back", () => {
		const { tasks, artifacts } = fixture();
		const parent = tasks.create({ title: "Parent" });
		const child = tasks.create({ title: "Child" });
		tasks.contain(parent.id, child.id);

		const originalUnlink = artifacts.unlink.bind(artifacts);
		let calls = 0;
		artifacts.unlink = ((link, context) => {
			calls++;
			if (calls === 2) throw new Error("simulated failure removing the second edge");
			return originalUnlink(link, context);
		}) as typeof artifacts.unlink;

		expect(() => tasks.uncontain(parent.id, child.id)).toThrow("simulated failure");
		const parentGraph = tasks.graph().nodes.find((n) => n.task.id === parent.id);
		const childGraph = tasks.graph().nodes.find((n) => n.task.id === child.id);
		expect(parentGraph?.childIds).toEqual([child.id]); // still contains — rolled back
		expect(childGraph?.parentIds).toEqual([parent.id]);
	});
});
