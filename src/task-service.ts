import type { Artifact } from "./domain/artifact.ts";
import { validateChecklist, type Checklist } from "./domain/checklist.ts";
import type { Gate, GateResult } from "./domain/gate.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { GateRunner } from "./ports/gate-runner.ts";

export interface TaskFilter {
	status?: string;
	text?: string;
	limit?: number;
}

export interface CreateTaskInput {
	title: string;
	body?: string;
	status?: "pending" | "active" | "done" | "failed";
	labels?: string[];
	extra?: Record<string, unknown>;
	gates?: Gate[];
	checklist?: Checklist;
	templateId?: string;
	parentId?: string;
	dependsOn?: string[];
}

export type TaskTransition = "start" | "fail" | "retry";

export interface TaskCompletion {
	artifact: Artifact;
	gates: GateResult[];
	completed: boolean;
}

export interface TaskNode {
	task: Artifact;
	parentIds: string[];
	childIds: string[];
	dependencyIds: string[];
}

export interface TaskGraph {
	nodes: TaskNode[];
	rootIds: string[];
}

const TASK_TRANSITIONS: Record<TaskTransition, { from: string[]; to: string }> = {
	start: { from: ["pending"], to: "active" },
	fail: { from: ["pending", "active"], to: "failed" },
	retry: { from: ["failed"], to: "pending" },
};

export class Tasks {
	constructor(
		private readonly artifacts: ArtifactStore,
		private readonly gates: GateRunner,
	) {}

	private require(id: string): Artifact {
		const artifact = this.artifacts.get(id);
		if (!artifact) throw new Error(`task artifact "${id}" not found`);
		if (artifact.kind !== "task") throw new Error(`artifact "${id}" is not a task`);
		return artifact;
	}

	create(input: CreateTaskInput): Artifact {
		if (input.parentId) this.require(input.parentId);
		for (const dependency of input.dependsOn ?? []) this.require(dependency);
		const extra: Record<string, unknown> = { ...(input.extra ?? {}) };
		if (input.gates !== undefined) extra["gates"] = input.gates;
		if (input.checklist !== undefined) extra["checklist"] = validateChecklist(input.checklist);
		const task = this.artifacts.create({
			kind: "task",
			title: input.title,
			body: input.body,
			status: input.status,
			labels: input.labels,
			extra,
			templateId: input.templateId,
		});
		if (input.parentId) this.contain(input.parentId, task.id);
		for (const dependency of input.dependsOn ?? []) this.depend(task.id, dependency);
		return this.show(task.id);
	}

	list(filter: TaskFilter = {}): Artifact[] {
		return this.artifacts.query({ kind: "task", ...filter });
	}

	graph(filter: TaskFilter = {}): TaskGraph {
		const tasks = this.list(filter);
		const byId = new Map(tasks.map((task) => [task.id, task]));
		const nodes = new Map(tasks.map((task) => [task.id, {
			task,
			parentIds: [] as string[],
			childIds: [] as string[],
			dependencyIds: [] as string[],
		}]));
		for (const edge of this.artifacts.relationships({ kind: "task", artifactIds: [...byId.keys()] })) {
			if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
			const parentId = edge.relation === "contains" ? edge.from : edge.relation === "part_of" ? edge.to : undefined;
			const childId = edge.relation === "contains" ? edge.to : edge.relation === "part_of" ? edge.from : undefined;
			if (parentId && childId && parentId !== childId) {
				const parent = nodes.get(parentId)!;
				const child = nodes.get(childId)!;
				if (!parent.childIds.includes(childId)) parent.childIds.push(childId);
				if (!child.parentIds.includes(parentId)) child.parentIds.push(parentId);
			}
			if (edge.relation === "depends_on") {
				const node = nodes.get(edge.from)!;
				if (!node.dependencyIds.includes(edge.to)) node.dependencyIds.push(edge.to);
			}
		}
		return {
			nodes: tasks.map((task) => nodes.get(task.id)!),
			rootIds: tasks.filter((task) => nodes.get(task.id)!.parentIds.length === 0).map((task) => task.id),
		};
	}

	show(id: string): Artifact {
		this.require(id);
		return this.artifacts.get(id, { tree: true })!;
	}

	transition(id: string, action: TaskTransition): Artifact {
		const task = this.require(id);
		const transition = TASK_TRANSITIONS[action];
		if (!transition.from.includes(task.status)) throw new Error(`cannot ${action} task from ${task.status}`);
		return this.artifacts.setStatus(id, transition.to)!;
	}

	complete(id: string): TaskCompletion {
		const task = this.requireActive(id);
		const results = this.gates.run(id);
		if (results.some((gate) => !gate.passed)) return { artifact: task, gates: results, completed: false };
		return { artifact: this.artifacts.setStatus(id, "done")!, gates: results, completed: true };
	}

	async completeAsync(id: string): Promise<TaskCompletion> {
		this.requireActive(id);
		const results = await this.gates.runAsync(id);
		if (results.some((gate) => !gate.passed)) return { artifact: this.require(id), gates: results, completed: false };
		const current = this.requireActive(id);
		return { artifact: this.artifacts.setStatus(current.id, "done")!, gates: results, completed: true };
	}

	runGates(id: string): Promise<GateResult[]> {
		this.require(id);
		return this.gates.runAsync(id);
	}

	setChecklist(id: string, checklist: Checklist): Artifact {
		const task = this.require(id);
		return this.artifacts.setExtra(id, { ...task.extra, checklist: validateChecklist(checklist) })!;
	}

	depend(id: string, dependencyId: string): Artifact {
		this.require(id);
		this.require(dependencyId);
		this.artifacts.link({ from: id, relation: "depends_on", to: dependencyId });
		return this.show(id);
	}

	contain(parentId: string, childId: string): Artifact {
		this.require(parentId);
		this.require(childId);
		this.artifacts.link({ from: parentId, relation: "contains", to: childId });
		this.artifacts.link({ from: childId, relation: "part_of", to: parentId });
		return this.show(parentId);
	}

	private requireActive(id: string): Artifact {
		const task = this.require(id);
		if (task.status !== "active") throw new Error(`cannot complete task from ${task.status}`);
		return task;
	}
}
