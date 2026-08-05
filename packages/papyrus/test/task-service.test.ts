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
import type { ArtifactEventPage, ArtifactEventQuery } from "../src/domain/artifact-event.ts";
import type { ArtifactTrashRecord } from "../src/domain/artifact-trash.ts";
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
			.filter((artifact) => (filter.labels ?? []).every((label) => artifact.labels.includes(label)))
			.slice(0, filter.limit ?? this.artifacts.size)
			.map((artifact) => structuredClone(artifact));
	}

	link(link: ArtifactLink): void {
		if (!this.edges.some((edge) => edge.from === link.from && edge.relation === link.relation && edge.to === link.to)) {
			this.edges.push({ ...link });
		}
	}

	unlink(link: ArtifactLink): boolean {
		const index = this.edges.findIndex((edge) => edge.from === link.from && edge.relation === link.relation && edge.to === link.to);
		if (index === -1) return false;
		this.edges.splice(index, 1);
		return true;
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

	events(_query: ArtifactEventQuery): ArtifactEventPage {
		return { events: [] };
	}

	// Trash is not exercised by any test in this file (see test/artifact-trash.test.ts for real
	// coverage against SQLite, where the cascade/trigger semantics actually matter); these exist
	// only to satisfy the ArtifactStore port.
	trash(id: string): ArtifactTrashRecord {
		return { artifactId: id, trashedAt: "2026-01-01T00:00:00.000Z", purgeAfter: "2026-01-31T00:00:00.000Z" };
	}
	restore(): { restored: boolean } {
		return { restored: false };
	}
	trashStatus(): ArtifactTrashRecord | null {
		return null;
	}
	listTrash(): ArtifactTrashRecord[] {
		return [];
	}
	purgeDueTrash(): number {
		return 0;
	}
}

class FakeGateRunner implements GateRunner {
	results: GateResult[] = [];
	readonly calls: string[] = [];
	readonly runOptions: Array<import("../src/domain/gate.ts").GateRunOptions | undefined> = [];
	readonly runAsyncOptions: Array<import("../src/domain/gate.ts").GateRunOptions | undefined> = [];
	run(artifactId: string, options?: import("../src/domain/gate.ts").GateRunOptions): GateResult[] {
		this.calls.push(artifactId);
		this.runOptions.push(options);
		return structuredClone(this.results);
	}
	async runAsync(artifactId: string, options?: import("../src/domain/gate.ts").GateRunOptions): Promise<GateResult[]> {
		this.calls.push(artifactId);
		this.runAsyncOptions.push(options);
		return structuredClone(this.results);
	}
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

		expect(created.extra.checklist).toEqual({
			"Write failing tests": { proof: [{ type: "test", target: "test/task-service.test.ts", expect: "proof requirement" }] },
			"Implement service": { proof: [{ type: "symbol", target: "src/task-service.ts#Tasks.create" }] },
		});
		expect(() => tasks.create({ title: "Legacy", checklist: ["No proof"] as unknown as never })).toThrow("item-to-proof map");
		expect(() =>
			tasks.create({
				title: "Missing target",
				checklist: { "Implement it": { proof: [{ type: "symbol", target: "" }] } },
			}),
		).toThrow("non-empty proof target");
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

	// Real incident: "tasks update" (title/body/labels/status only) silently accepted and dropped
	// a `gates` field with no error, repeatedly, across several attempts to fix a broken gate
	// command -- there was no way to change gates after creation at all. setGates is that missing
	// operation, mirroring setChecklist exactly.
	it("replaces gates without overwriting checklist or other task metadata", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const created = tasks.create({
			title: "Update gates",
			extra: { owner: "agent" },
			checklist: { "Write tests": { proof: [{ type: "test" as const, target: "test/task-service.test.ts" }] } },
		});

		const updated = tasks.setGates(created.id, [{ type: "command", target: "bun test 2>&1 | tail -3", expect: "0 fail" }]);

		expect(updated.extra).toEqual({
			owner: "agent",
			checklist: { "Write tests": { proof: [{ type: "test", target: "test/task-service.test.ts" }] } },
			gates: [{ type: "command", target: "bun test 2>&1 | tail -3", expect: "0 fail" }],
		});
	});

	it("rejects malformed gates at both creation and setGates, instead of silently dropping or storing them", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		expect(() => tasks.create({ title: "Bad gate type", gates: [{ type: "not-a-real-type", target: "x" }] as never })).toThrow(
			"requires a valid type",
		);
		expect(() => tasks.create({ title: "Bad gate target", gates: [{ type: "command", target: "" }] as never })).toThrow("non-empty target");

		const created = tasks.create({ title: "Scoped", gates: [{ type: "command", target: "echo ok" }] });
		expect(() => tasks.setGates(created.id, [{ type: "bogus", target: "x" }] as never)).toThrow("requires a valid type");
		// The rejected setGates call must not have partially applied.
		expect(tasks.show(created.id).extra.gates).toEqual([{ type: "command", target: "echo ok" }]);
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

	it("threads the task's project_root through to the gate runner as cwd, on every completion path", async () => {
		// Real incident: a command gate with no explicit cwd inherited the Papyrus daemon's own
		// process cwd instead of the task's project, letting a gate like `bun test` recursively
		// discover and run every test file under every project on the machine. This is the
		// daemon-level half of the fix (the executeGateCommand-level half is covered directly in
		// ops.test.ts): TaskService must always resolve the task's own project_root and pass it as
		// `cwd`, never leave it to whatever directory the gate runner happens to inherit.
		const artifacts = new FakeArtifactStore();
		const gates = new FakeGateRunner();
		const tasks = new Tasks(artifacts, gates);

		const syncTask = tasks.create({ title: "Scoped sync", projectRoot: "/tmp/fake-project" });
		tasks.transition(syncTask.id, "start");
		tasks.transition(syncTask.id, "submit");
		tasks.complete(syncTask.id);
		expect(gates.runOptions.at(-1)?.cwd).toBe("/tmp/fake-project");

		const asyncTask = tasks.create({ title: "Scoped async", projectRoot: "/tmp/fake-project" });
		tasks.transition(asyncTask.id, "start");
		tasks.transition(asyncTask.id, "submit");
		await tasks.completeAsync(asyncTask.id);
		expect(gates.runAsyncOptions.at(-1)?.cwd).toBe("/tmp/fake-project");

		await tasks.runGates(asyncTask.id);
		expect(gates.runAsyncOptions.at(-1)?.cwd).toBe("/tmp/fake-project");
	});

	it("passes no cwd for an unscoped task, rather than fabricating one", async () => {
		const artifacts = new FakeArtifactStore();
		const gates = new FakeGateRunner();
		const tasks = new Tasks(artifacts, gates);
		const task = tasks.create({ title: "Unscoped" });
		tasks.transition(task.id, "start");
		tasks.transition(task.id, "submit");

		tasks.complete(task.id);
		expect(gates.runOptions.at(-1)?.cwd).toBeUndefined();
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
		// Readiness fires for EVERY newly-unblocked successor, not just the one auto-focused.
		expect(tasks.history(left.id).events.map((event) => event.type)).toContain("became_ready");
		expect(tasks.history(right.id).events.map((event) => event.type)).toContain("became_ready");
	});

	it("emits became_ready when removing a blocking dependency edge leaves zero unmet dependencies", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const prerequisite = tasks.create({ title: "Prerequisite" });
		const dependent = tasks.create({ title: "Dependent", dependsOn: [prerequisite.id] });

		tasks.undepend(dependent.id, prerequisite.id);

		expect(tasks.history(dependent.id).events.map((event) => event.type)).toContain("became_ready");
	});

	it("does NOT emit became_ready when removing an already-satisfied dependency, or one that leaves other dependencies unmet", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const done = tasks.create({ title: "Already done", status: "done" });
		const stillPending = tasks.create({ title: "Still pending" });
		const dependent = tasks.create({ title: "Dependent", dependsOn: [done.id, stillPending.id] });

		// Removing the satisfied one changes nothing -- the task was never blocked by it.
		tasks.undepend(dependent.id, done.id);
		expect(tasks.history(dependent.id).events.map((event) => event.type)).not.toContain("became_ready");

		// Removing the still-unmet one now leaves zero dependencies -- this one DOES fire.
		tasks.undepend(dependent.id, stillPending.id);
		expect(tasks.history(dependent.id).events.map((event) => event.type)).toContain("became_ready");
	});

	it("refuses completion while an active Discussion blocks the task, naming both by title not id", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		const task = tasks.create({ title: "Ship feature X", status: "review" });
		const discussion = artifacts.create({
			kind: "task",
			subtype: "discussion",
			title: "Which approach?",
			extra: { discussion: { state: "active", roundCount: 1 } },
		});
		artifacts.link({ from: discussion.id, relation: "blocks", to: task.id });

		expect(() => tasks.complete(task.id)).toThrow('task "Ship feature X" is blocked by 1 active Discussion(s): "Which approach?"');

		artifacts.setExtra(discussion.id, { discussion: { state: "settled", roundCount: 1, settlement: "Went with approach A" } });
		expect(tasks.complete(task.id).completed).toBe(true);
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

	it("links a dependency between two tasks sharing one small project, unaffected by unrelated tasks elsewhere pushing the daemon-wide total over the execution-graph bound", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());

		// TASK_EXECUTION_MAX_NODES is 1000 -- this alone would already break an unscoped graph build.
		for (let index = 0; index < 1001; index++) {
			tasks.create({ title: `Filler ${index}`, projectRoot: "/tmp/unrelated-project" });
		}

		const prerequisite = tasks.create({ title: "Prerequisite", projectRoot: "/tmp/small-project" });
		const dependent = tasks.create({ title: "Dependent", projectRoot: "/tmp/small-project" });

		expect(() => tasks.depend(dependent.id, prerequisite.id)).not.toThrow();
		const graph = tasks.graph({ projectRoot: "/tmp/small-project", scope: "project" });
		expect(graph.nodes.find((node) => node.task.id === dependent.id)?.dependencyIds).toContain(prerequisite.id);
	});

	it("links a genuine cross-project dependency unaffected by an unrelated third project pushing the daemon-wide total over the execution-graph bound", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		for (let index = 0; index < 1001; index++) {
			tasks.create({ title: `Filler ${index}`, projectRoot: "/tmp/unrelated-project" });
		}
		const fromOtherProject = tasks.create({ title: "From project A", projectRoot: "/tmp/project-a" });
		const toOtherProject = tasks.create({ title: "From project B", projectRoot: "/tmp/project-b" });

		// The two endpoints don't share a project, but both are known -- dependencyCheckGraph
		// scopes to the union of their own two projects instead of the full unscoped daemon graph,
		// so an unrelated third project's own task count is irrelevant to this pair.
		expect(() => tasks.depend(fromOtherProject.id, toOtherProject.id)).not.toThrow();
		// show() reads edges directly (tree: true), not through graph()'s own bound-checked
		// build -- the full unscoped graph here would itself exceed 1000 nodes (1001 filler +
		// 2 real), which is exactly the daemon-wide cost this fix avoids paying just to verify.
		const shown = tasks.show(fromOtherProject.id);
		expect(shown.edges).toContainEqual({ from: fromOtherProject.id, relation: "depends_on", to: toOtherProject.id });
	});

	it("still enforces the execution-graph bound when the union of two genuinely large cross-project scopes itself exceeds it", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		for (let index = 0; index < 600; index++) {
			tasks.create({ title: `A filler ${index}`, projectRoot: "/tmp/project-a" });
		}
		for (let index = 0; index < 600; index++) {
			tasks.create({ title: `B filler ${index}`, projectRoot: "/tmp/project-b" });
		}
		const fromOtherProject = tasks.create({ title: "From project A", projectRoot: "/tmp/project-a" });
		const toOtherProject = tasks.create({ title: "From project B", projectRoot: "/tmp/project-b" });

		expect(() => tasks.depend(fromOtherProject.id, toOtherProject.id)).toThrow("exceeds 1000 nodes");
	});

	it("starts only tasks whose complete prerequisite set is done", () => {
		const artifacts = new FakeArtifactStore();
		const tasks = new Tasks(artifacts, new FakeGateRunner());
		const prerequisite = tasks.create({ title: "Prerequisite" });
		const dependent = tasks.create({ title: "Dependent", dependsOn: [prerequisite.id] });

		expect(() => tasks.transition(dependent.id, "start")).toThrow('blocked by dependencies: "Prerequisite"');
		artifacts.setStatus(prerequisite.id, "done");
		expect(tasks.transition(dependent.id, "start").status).toBe("in-progress");
		expect(tasks.active()?.id).toBe(dependent.id);
	});

	it("updates an existing Task without replacing its identity, lifecycle, or metadata", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const task = tasks.create({ title: "Old title", body: "Old body", labels: ["old"], extra: { owner: "papyrus" } });
		const updated = tasks.update(task.id, { title: "New title", body: "New body", labels: ["new"] }, { actor: "user", source: "test" });

		expect(updated).toMatchObject({
			id: task.id,
			title: "New title",
			body: "New body",
			labels: ["new"],
			status: "todo",
			extra: { owner: "papyrus" },
		});
		expect(tasks.history(task.id, { direction: "asc" }).events.at(-1)).toMatchObject({
			type: "updated",
			actor: "user",
			source: "test",
			evidence: { result: "fields:body,labels,title" },
		});
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
		expect(tasks.pauseFocus({ reason: "manual pause" })).toMatchObject({
			artifact: { id: review.id },
			status: "paused",
			pauseReason: "manual pause",
		});
		expect(tasks.active()).toBeNull();
		expect(tasks.focused()).toMatchObject({ artifact: { id: review.id }, status: "paused" });
		expect(tasks.unpauseFocus()).toMatchObject({ artifact: { id: review.id }, status: "active" });
		expect(tasks.active()?.id).toBe(review.id);
		expect(tasks.show(todo.id).status).toBe("todo");
		expect(tasks.show(review.id).status).toBe("review");
		expect(
			tasks
				.graph()
				.nodes.filter((node) => node.active)
				.map((node) => node.task.id),
		).toEqual([review.id]);
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
		const recovered = tasks.update(
			accidental.id,
			{ status: "todo" },
			{ actor: "agent", source: "defect-repair", reason: "created with migrated row-order default" },
		);
		expect(recovered.status).toBe("todo");
		expect(
			tasks
				.history(accidental.id, { direction: "asc" })
				.events.map((event) => ({ type: event.type, from: event.fromStatus, to: event.toStatus })),
		).toEqual([
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

	it("cancelSubtree cancels a whole containment tree in one call, skipping already-terminal tasks instead of erroring on them", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const root = tasks.create({ title: "Root" });
		const childA = tasks.create({ title: "Child A" });
		const childB = tasks.create({ title: "Child B" });
		const grandchild = tasks.create({ title: "Grandchild" });
		tasks.contain(root.id, childA.id);
		tasks.contain(root.id, childB.id);
		tasks.contain(childA.id, grandchild.id);
		// Already finished before the rest needed abandoning -- must be skipped, not throw.
		tasks.transition(childB.id, "start");
		tasks.transition(childB.id, "submit");
		tasks.transition(childB.id, "cancel");

		const outcome = tasks.cancelSubtree(root.id);
		expect(outcome.canceled.sort()).toEqual([root.id, childA.id, grandchild.id].sort());
		expect(outcome.skipped).toEqual([childB.id]);
		expect(tasks.show(root.id).status).toBe("canceled");
		expect(tasks.show(childA.id).status).toBe("canceled");
		expect(tasks.show(grandchild.id).status).toBe("canceled");
		expect(tasks.show(childB.id).status).toBe("canceled"); // unchanged, was already terminal
	});

	it("cancelSubtree does not follow depends_on -- only containment cascades", () => {
		const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
		const dependent = tasks.create({ title: "Dependent" });
		const prerequisite = tasks.create({ title: "Prerequisite" });
		tasks.depend(dependent.id, prerequisite.id);

		const outcome = tasks.cancelSubtree(dependent.id);
		expect(outcome.canceled).toEqual([dependent.id]);
		expect(tasks.show(prerequisite.id).status).toBe("todo"); // untouched
	});

	it("rejects legacy checklist entries without typed proof while still running gates", () => {
		const gates = new FakeGateRunner();
		const tasks = new Tasks(new FakeArtifactStore(), gates);
		const task = tasks.create({ title: "Legacy evidence", status: "review", extra: { checklist: ["Claimed done"] } });

		const result = tasks.complete(task.id);
		expect(result.completed).toBe(false);
		expect(result.artifact.status).toBe("rejected");
		expect(result.checklist).toEqual([
			{
				item: "Claimed done",
				proof: [],
				accepted: false,
				reason: "typed proof reference required",
			},
		]);
		expect(gates.calls).toEqual([task.id]);
	});

	describe("list/graph: filtering by label", () => {
		it("'all' scope: filters to tasks carrying every requested label (AND semantics)", () => {
			const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
			tasks.create({ title: "Urgent and blocked", labels: ["urgent", "blocked"] });
			tasks.create({ title: "Urgent only", labels: ["urgent"] });
			tasks.create({ title: "Unlabeled" });

			const urgent = tasks.list({ labels: ["urgent"] });
			expect(urgent.map((task) => task.title).sort()).toEqual(["Urgent and blocked", "Urgent only"]);

			const both = tasks.list({ labels: ["urgent", "blocked"] });
			expect(both.map((task) => task.title)).toEqual(["Urgent and blocked"]);
		});

		it("project scope: label filtering composes with the existing project boundary", () => {
			const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
			tasks.create({ title: "In-project urgent", labels: ["urgent"], projectRoot: "/workspace/proj" });
			tasks.create({ title: "In-project other", labels: ["other"], projectRoot: "/workspace/proj" });
			tasks.create({ title: "Different project urgent", labels: ["urgent"], projectRoot: "/workspace/other" });

			const found = tasks.list({ scope: "project", projectRoot: "/workspace/proj", labels: ["urgent"] });
			expect(found.map((task) => task.title)).toEqual(["In-project urgent"]);
		});

		it("graph(): also respects a label filter, not just list()", () => {
			const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
			tasks.create({ title: "Urgent", labels: ["urgent"] });
			tasks.create({ title: "Not urgent" });

			const graph = tasks.graph({ labels: ["urgent"] });
			expect(graph.nodes.map((node) => node.task.title)).toEqual(["Urgent"]);
		});
	});

	describe("lease claims: concurrent work reservation, orthogonal to lifecycle and Focus", () => {
		it("claims, heartbeats, and releases a lease -- none of it starts the task or touches Focus", () => {
			const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
			const task = tasks.create({ title: "Ready work" });
			const claimed = tasks.claimLease(task.id, "worker-a", 60_000, "picking this up");
			expect(claimed.owner).toBe("worker-a");
			expect(tasks.show(task.id).status).toBe("todo");
			expect(tasks.active()).toBeNull();

			const renewed = tasks.heartbeatLease(task.id, "worker-a", claimed.token, 120_000);
			expect(renewed.token).toBe(claimed.token);
			expect(new Date(renewed.leaseExpiresAt).getTime()).toBeGreaterThan(new Date(claimed.leaseExpiresAt).getTime());

			expect(tasks.releaseLease(task.id, "worker-a", claimed.token)).toEqual({ released: true });
			expect(tasks.getLease(task.id)).toBeUndefined();
		});

		it("refuses to claim a task already leased by a different owner, and refuses to release/heartbeat someone else's lease", () => {
			const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
			const task = tasks.create({ title: "Contended work" });
			const claimed = tasks.claimLease(task.id, "worker-a", 60_000);
			expect(() => tasks.claimLease(task.id, "worker-b", 60_000)).toThrow(/already leased by "worker-a"/);
			expect(() => tasks.heartbeatLease(task.id, "worker-b", claimed.token)).toThrow(/different owner\/token/);
			expect(() => tasks.releaseLease(task.id, "worker-b", claimed.token)).toThrow(/different owner\/token/);
		});

		it("multiple sessions can each Focus the same task while only one holds its lease -- lease and Focus are independent axes", () => {
			const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
			const task = tasks.create({ title: "Shared visibility" });
			tasks.focus(task.id, { sessionId: "session-a" });
			tasks.focus(task.id, { sessionId: "session-b" });
			const claimed = tasks.claimLease(task.id, "worker-a", 60_000);
			expect(tasks.active({ sessionId: "session-a" })?.id).toBe(task.id);
			expect(tasks.active({ sessionId: "session-b" })?.id).toBe(task.id);
			expect(tasks.getLease(task.id)?.owner).toBe(claimed.owner);
		});

		it("releasing and getting a lease refuse an unknown task id, matching every other Tasks method's require() guard", () => {
			const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
			expect(() => tasks.claimLease("missing", "worker-a")).toThrow('task artifact "missing" not found');
			expect(() => tasks.getLease("missing")).toThrow('task artifact "missing" not found');
		});

		it("reapStaleLeases removes only leases past their own expiry, independent of TASK_FOCUS_STALE_AFTER_MS", () => {
			const tasks = new Tasks(new FakeArtifactStore(), new FakeGateRunner());
			const expiring = tasks.create({ title: "Short lease" });
			const longLived = tasks.create({ title: "Long lease" });
			tasks.claimLease(expiring.id, "worker-a", 1_000);
			tasks.claimLease(longLived.id, "worker-b", 60_000);
			const removed = tasks.reapStaleLeases(() => new Date(Date.now() + 2_000).toISOString());
			expect(removed).toBe(1);
			expect(tasks.getLease(longLived.id)).toBeDefined();
		});
	});
});
