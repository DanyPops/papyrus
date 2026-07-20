import { describe, expect, it } from "bun:test";
import type {
	Artifact,
	ArtifactEdge,
	ArtifactGraphOptions,
	ArtifactLink,
	ArtifactQuery,
	CreateArtifactInput,
	RelationshipQuery,
	UpdateArtifactInput,
} from "../src/domain/artifact.ts";
import type { GateResult } from "../src/domain/gate.ts";
import type { ArtifactStore } from "../src/ports/artifact-store.ts";
import type { GateRunner } from "../src/ports/gate-runner.ts";
import { projectTaskExecution } from "../src/task-execution.ts";
import { Tasks } from "../src/task-service.ts";

class FakeArtifactStore implements ArtifactStore {
	private sequence = 0;
	readonly artifacts = new Map<string, Artifact>();
	readonly edges: ArtifactEdge[] = [];

	create(input: CreateArtifactInput): Artifact {
		const id = input.id ?? `task-${++this.sequence}`;
		const artifact: Artifact = {
			id,
			kind: input.kind ?? "doc",
			title: input.title ?? "Untitled",
			status: input.status ?? (input.kind === "task" ? "todo" : "draft"),
			subtype: input.subtype ?? "",
			body: input.body ?? "",
			labels: input.labels ?? [],
			extra: input.extra ?? {},
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		};
		this.artifacts.set(id, artifact);
		return structuredClone(artifact);
	}

	get(id: string, options?: ArtifactGraphOptions): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		return {
			...structuredClone(artifact),
			...(options?.tree ? { edges: this.edges.filter((edge) => edge.from === id || edge.to === id) } : {}),
		};
	}

	query(filter: ArtifactQuery): Artifact[] {
		return [...this.artifacts.values()]
			.filter((artifact) => !filter.kind || artifact.kind === filter.kind)
			.filter((artifact) => !filter.status || artifact.status === filter.status)
			.slice(0, filter.limit ?? this.artifacts.size)
			.map((artifact) => structuredClone(artifact));
	}

	link(link: ArtifactLink): void {
		if (!this.edges.some((edge) => edge.from === link.from && edge.relation === link.relation && edge.to === link.to)) {
			this.edges.push({ ...link });
		}
	}

	setStatus(id: string, status: string): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		artifact.status = status;
		return structuredClone(artifact);
	}

	setExtra(id: string, extra: Record<string, unknown>): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		artifact.extra = structuredClone(extra);
		return structuredClone(artifact);
	}

	updateContent(id: string, input: UpdateArtifactInput): Artifact | null {
		const artifact = this.artifacts.get(id);
		if (!artifact) return null;
		if (input.title !== undefined) artifact.title = input.title;
		if (input.body !== undefined) artifact.body = input.body;
		if (input.labels !== undefined) artifact.labels = [...input.labels];
		artifact.updated_at = new Date().toISOString();
		return structuredClone(artifact);
	}

	relationships(filter: RelationshipQuery = {}): ArtifactEdge[] {
		const ids = filter.artifactIds ? new Set(filter.artifactIds) : undefined;
		return this.edges
			.filter((edge) => !ids || ids.has(edge.from) || ids.has(edge.to))
			.slice(0, filter.limit ?? this.edges.length)
			.map((edge) => ({ ...edge }));
	}
}

class FakeGateRunner implements GateRunner {
	results: GateResult[] = [];
	readonly calls: string[] = [];
	run(artifactId: string): GateResult[] {
		this.calls.push(artifactId);
		return structuredClone(this.results);
	}
	async runAsync(artifactId: string): Promise<GateResult[]> { return this.run(artifactId); }
}

describe("Tasks port behavior", () => {
	it("builds task composition through the ArtifactStore port without SQLite", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		const epic = tasks.create({ title: "Epic" });
		const dependency = tasks.create({ title: "Dependency" });
		const child = tasks.create({ title: "Child", parentId: epic.id, dependsOn: [dependency.id] });

		const graph = tasks.graph();
		expect(graph.nodes.find((node) => node.task.id === epic.id)?.childIds).toEqual([child.id]);
		expect(graph.nodes.find((node) => node.task.id === child.id)?.dependencyIds).toEqual([dependency.id]);
	});

	it("requires every checklist item to carry an evidence reference", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const created = tasks.create({
			title: "Evidence-bearing task",
			checklist: {
				"Write failing tests": { proof: [{ type: "test", target: "test/task-service.test.ts", expect: "proof requirement" }] },
				"Implement service": { proof: [{ type: "symbol", target: "src/task-service.ts#Tasks.create" }] },
			},
		});

		expect(created.extra["checklist"]).toEqual({
			"Write failing tests": { proof: [{ type: "test", target: "test/task-service.test.ts", expect: "proof requirement" }] },
			"Implement service": { proof: [{ type: "symbol", target: "src/task-service.ts#Tasks.create" }] },
		});
		expect(() => tasks.create({ title: "Legacy", checklist: ["No proof"] as unknown as never })).toThrow("item-to-proof map");
		expect(() => tasks.create({
			title: "Missing target",
			checklist: { "Implement it": { proof: [{ type: "symbol", target: "" }] } },
		})).toThrow("non-empty proof target");
	});

	it("replaces a checklist without overwriting gates or other task metadata", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const created = tasks.create({
			title: "Update checklist",
			extra: { owner: "agent" },
			gates: [{ type: "command", target: "bun test" }],
		});
		const checklist = {
			"Write tests": { proof: [{ type: "test" as const, target: "test/task-service.test.ts" }] },
		};

		const updated = tasks.setChecklist(created.id, checklist);

		expect(updated.extra).toEqual({
			owner: "agent",
			gates: [{ type: "command", target: "bun test" }],
			checklist,
		});
	});

	it("rejects a task when review gates fail and keeps it focused for corrective effort", () => {
		const artifacts = new FakeArtifactStore();
		const gates = new FakeGateRunner();
		gates.results = [{ gate: { type: "command", target: "test" }, passed: false, output: "failed" }];
		const tasks = new Tasks(artifacts, gates);
		const task = tasks.create({ title: "Gated" });
		tasks.transition(task.id, "start");
		tasks.transition(task.id, "submit");

		expect(tasks.complete(task.id).completed).toBe(false);
		expect(tasks.show(task.id).status).toBe("rejected");
		expect(tasks.active()?.id).toBe(task.id);
	});

	it("completes passing review and focuses one ready fan-out successor without claiming effort", () => {
		const artifacts = new FakeArtifactStore();
		const gates = new FakeGateRunner();
		const tasks = new Tasks(artifacts, gates);
		const root = tasks.create({ title: "Root", status: "review" });
		const left = tasks.create({ title: "Left", dependsOn: [root.id] });
		const right = tasks.create({ title: "Right", dependsOn: [root.id] });
		tasks.focus(root.id);

		const result = tasks.complete(root.id);

		expect(result.completed).toBe(true);
		expect(result.focused?.id).toBe(left.id);
		expect(result.blocked).toEqual([]);
		expect(tasks.show(root.id).status).toBe("done");
		expect(tasks.show(left.id).status).toBe("todo");
		expect(tasks.show(right.id).status).toBe("todo");
		expect(tasks.active()?.id).toBe(left.id);
		expect(gates.calls).toEqual([root.id]);
	});

	it("holds a fan-in successor until every prerequisite is done", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		const left = tasks.create({ title: "Left", status: "review" });
		const right = tasks.create({ title: "Right", status: "review" });
		const join = tasks.create({ title: "Join", dependsOn: [left.id, right.id] });

		const first = tasks.complete(left.id);
		expect(first.focused).toBeNull();
		expect(first.blocked).toHaveLength(1);
		expect(first.blocked[0]?.artifact).toMatchObject({ id: join.id, status: "todo" });
		expect(first.blocked[0]?.dependencyIds).toEqual([right.id]);
		expect(tasks.show(join.id).status).toBe("todo");

		const second = tasks.complete(right.id);
		expect(second.focused?.id).toBe(join.id);
		expect(tasks.show(join.id).status).toBe("todo");
		expect(tasks.active()?.id).toBe(join.id);
	});

	it("projects deterministic execution layers and readiness for fan-out and fan-in", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		const root = tasks.create({ title: "Root", status: "done" });
		const left = tasks.create({ title: "Left", dependsOn: [root.id] });
		const right = tasks.create({ title: "Right", dependsOn: [root.id] });
		const join = tasks.create({ title: "Join", dependsOn: [left.id, right.id] });

		const plan = projectTaskExecution(tasks.graph());

		expect(plan.layers).toEqual([[root.id], [left.id, right.id], [join.id]]);
		expect(plan.cycleIds).toEqual([]);
		expect(plan.nodes.find((node) => node.id === root.id)).toMatchObject({
			state: "done",
			layer: 0,
			successorIds: [left.id, right.id],
		});
		expect(plan.nodes.find((node) => node.id === left.id)).toMatchObject({ state: "ready", layer: 1 });
		expect(plan.nodes.find((node) => node.id === right.id)).toMatchObject({ state: "ready", layer: 1 });
		expect(plan.nodes.find((node) => node.id === join.id)).toMatchObject({ state: "blocked", layer: 2 });
	});

	it("rejects self-dependencies and dependency cycles before storing an edge", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		const first = tasks.create({ title: "First" });
		const second = tasks.create({ title: "Second" });
		const third = tasks.create({ title: "Third" });

		expect(() => tasks.depend(first.id, first.id)).toThrow("cannot depend on itself");
		tasks.depend(second.id, first.id);
		tasks.depend(third.id, second.id);
		expect(() => tasks.depend(first.id, third.id)).toThrow("dependency cycle");
		expect(artifacts.edges).not.toContainEqual({ from: first.id, relation: "depends_on", to: third.id });
	});

	it("starts only tasks whose complete prerequisite set is done", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		const prerequisite = tasks.create({ title: "Prerequisite" });
		const dependent = tasks.create({ title: "Dependent", dependsOn: [prerequisite.id] });

		expect(() => tasks.transition(dependent.id, "start")).toThrow(`blocked by dependencies: ${prerequisite.id}`);
		artifacts.setStatus(prerequisite.id, "done");
		expect(tasks.transition(dependent.id, "start").status).toBe("in-progress");
		expect(tasks.active()?.id).toBe(dependent.id);
	});

	it("updates an existing Task without replacing its identity, lifecycle, or metadata", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const task = tasks.create({ title: "Old title", body: "Old body", labels: ["old"], extra: { owner: "papyrus" } });
		const updated = tasks.update(task.id, { title: "New title", body: "New body", labels: ["new"] }, { actor: "user", source: "test" });

		expect(updated).toMatchObject({ id: task.id, title: "New title", body: "New body", labels: ["new"], status: "todo", extra: { owner: "papyrus" } });
		expect(tasks.history(task.id, { direction: "asc" }).events.at(-1)).toMatchObject({ type: "updated", actor: "user", source: "test", evidence: { result: "fields:body,labels,title" } });
		expect(() => tasks.update(task.id, {})).toThrow("requires title, body, or labels");
	});

	it("keeps singleton active focus independent from lifecycle", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const todo = tasks.create({ title: "Todo" });
		const review = tasks.create({ title: "Review", status: "review" });

		tasks.focus(todo.id);
		expect(tasks.active()?.id).toBe(todo.id);
		tasks.focus(review.id);
		expect(tasks.active()?.id).toBe(review.id);
		expect(tasks.pauseFocus({ reason: "manual pause" })).toMatchObject({ artifact: { id: review.id }, status: "paused", pauseReason: "manual pause" });
		expect(tasks.active()).toBeNull();
		expect(tasks.focused()).toMatchObject({ artifact: { id: review.id }, status: "paused" });
		expect(tasks.unpauseFocus()).toMatchObject({ artifact: { id: review.id }, status: "active" });
		expect(tasks.active()?.id).toBe(review.id);
		expect(tasks.show(todo.id).status).toBe("todo");
		expect(tasks.show(review.id).status).toBe("review");
		expect(tasks.graph().nodes.filter((node) => node.active).map((node) => node.task.id)).toEqual([review.id]);
	});

	it("propagates partial effort from a nested task to todo ancestors", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const epic = tasks.create({ title: "Epic" });
		const parent = tasks.create({ title: "Parent", parentId: epic.id });
		const child = tasks.create({ title: "Child", parentId: parent.id });

		expect(tasks.transition(child.id, "start").status).toBe("in-progress");
		expect(tasks.show(parent.id).status).toBe("in-progress");
		expect(tasks.show(epic.id).status).toBe("in-progress");
		expect(tasks.active()?.id).toBe(child.id);
	});

	it("recovers only a Task accidentally created terminal and appends lifecycle history", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const accidental = tasks.create({ title: "Accidental terminal", status: "done" });
		expect(() => tasks.update(accidental.id, { status: "todo" }, {})).toThrow("reason");
		const recovered = tasks.update(accidental.id, { status: "todo" }, { actor: "agent", source: "defect-repair", reason: "created with migrated row-order default" });
		expect(recovered.status).toBe("todo");
		expect(tasks.history(accidental.id, { direction: "asc" }).events.map((event) => ({ type: event.type, from: event.fromStatus, to: event.toStatus }))).toEqual([
			{ type: "created", from: undefined, to: "done" },
			{ type: "creation_recovered", from: "done", to: "todo" },
		]);

		const legitimate = tasks.create({ title: "Legitimate completion", status: "review" });
		tasks.complete(legitimate.id);
		expect(() => tasks.update(legitimate.id, { status: "todo" }, { reason: "not accidental" })).toThrow("not terminal at creation");
	});

	it("enforces review, rejection, retry, and canceled lifecycle transitions", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const task = tasks.create({ title: "Lifecycle" });
		expect(task.status).toBe("todo");
		expect(() => tasks.complete(task.id)).toThrow("cannot complete task from todo");
		expect(tasks.transition(task.id, "start").status).toBe("in-progress");
		expect(tasks.transition(task.id, "submit").status).toBe("review");
		expect(tasks.transition(task.id, "reject").status).toBe("rejected");
		expect(tasks.transition(task.id, "retry").status).toBe("in-progress");
		expect(tasks.transition(task.id, "cancel").status).toBe("canceled");
		expect(tasks.active()).toBeNull();
		expect(() => tasks.transition(task.id, "start")).toThrow("cannot start task from canceled");
	});

	it("rejects legacy checklist entries without typed proof while still running gates", () => {
		const gates = new FakeGateRunner();
		const tasks = new Tasks(new FakeArtifactStore(), gates);
		const task = tasks.create({ title: "Legacy evidence", status: "review", extra: { checklist: ["Claimed done"] } });

		const result = tasks.complete(task.id);
		expect(result.completed).toBe(false);
		expect(result.artifact.status).toBe("rejected");
		expect(result.checklist).toEqual([{
			item: "Claimed done",
			proof: [],
			accepted: false,
			reason: "typed proof reference required",
		}]);
		expect(gates.calls).toEqual([task.id]);
	});
});
