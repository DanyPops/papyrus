import { TASK_EXECUTION_MAX_DEGREE, TASK_EXECUTION_MAX_EDGES, TASK_EXECUTION_MAX_NODES } from "./constants.ts";
import type { Artifact } from "./domain/artifact.ts";
import { validateChecklist, type Checklist } from "./domain/checklist.ts";
import type { Gate, GateResult } from "./domain/gate.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { GateRunner } from "./ports/gate-runner.ts";
import { assertDependencyEdgeAllowed } from "./task-execution.ts";

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

export interface TaskBlockage {
	artifact: Artifact;
	dependencyIds: string[];
}

export interface TaskCompletion {
	artifact: Artifact;
	gates: GateResult[];
	completed: boolean;
	started: Artifact[];
	blocked: TaskBlockage[];
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
		if ((input.dependsOn?.length ?? 0) > TASK_EXECUTION_MAX_DEGREE) {
			throw new Error(`task cannot exceed ${TASK_EXECUTION_MAX_DEGREE} prerequisites`);
		}
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
		const requestedLimit = filter.limit ?? TASK_EXECUTION_MAX_NODES + 1;
		if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > TASK_EXECUTION_MAX_NODES + 1) {
			throw new Error(`task graph limit must be between 1 and ${TASK_EXECUTION_MAX_NODES + 1}`);
		}
		const tasks = this.list({ ...filter, limit: requestedLimit });
		if (tasks.length > TASK_EXECUTION_MAX_NODES) {
			throw new Error(`task execution graph exceeds ${TASK_EXECUTION_MAX_NODES} nodes`);
		}
		const byId = new Map(tasks.map((task) => [task.id, task]));
		const nodes = new Map(tasks.map((task) => [task.id, {
			task,
			parentIds: [] as string[],
			childIds: [] as string[],
			dependencyIds: [] as string[],
		}]));
		const relationships = this.artifacts.relationships({
			kind: "task",
			artifactIds: [...byId.keys()],
			limit: TASK_EXECUTION_MAX_EDGES + 1,
		});
		if (relationships.length > TASK_EXECUTION_MAX_EDGES) {
			throw new Error(`task execution graph exceeds ${TASK_EXECUTION_MAX_EDGES} relationships`);
		}
		for (const edge of relationships) {
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
		if (action === "start") {
			const blocking = this.dependencyIds(id).filter((dependencyId) => this.require(dependencyId).status !== "done");
			if (blocking.length > 0) throw new Error(`task "${id}" is blocked by dependencies: ${blocking.join(", ")}`);
		}
		return this.artifacts.setStatus(id, transition.to)!;
	}

	complete(id: string): TaskCompletion {
		const task = this.requireActive(id);
		const results = this.gates.run(id);
		if (results.some((gate) => !gate.passed)) {
			return { artifact: task, gates: results, completed: false, started: [], blocked: [] };
		}
		return this.finish(id, results);
	}

	async completeAsync(id: string): Promise<TaskCompletion> {
		this.requireActive(id);
		const results = await this.gates.runAsync(id);
		if (results.some((gate) => !gate.passed)) {
			return { artifact: this.require(id), gates: results, completed: false, started: [], blocked: [] };
		}
		const current = this.requireActive(id);
		return this.finish(current.id, results);
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
		const graph = this.graph();
		assertDependencyEdgeAllowed(graph, id, dependencyId);
		const node = graph.nodes.find((entry) => entry.task.id === id)!;
		if (node.dependencyIds.includes(dependencyId)) return this.show(id);
		if (node.dependencyIds.length >= TASK_EXECUTION_MAX_DEGREE) {
			throw new Error(`task "${id}" cannot exceed ${TASK_EXECUTION_MAX_DEGREE} prerequisites`);
		}
		const successorCount = graph.nodes.filter((entry) => entry.dependencyIds.includes(dependencyId)).length;
		if (successorCount >= TASK_EXECUTION_MAX_DEGREE) {
			throw new Error(`task "${dependencyId}" cannot exceed ${TASK_EXECUTION_MAX_DEGREE} successors`);
		}
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

	private relationships(id: string) {
		const relationships = this.artifacts.relationships({
			kind: "task",
			artifactIds: [id],
			limit: TASK_EXECUTION_MAX_EDGES + 1,
		});
		if (relationships.length > TASK_EXECUTION_MAX_EDGES) {
			throw new Error(`task "${id}" exceeds ${TASK_EXECUTION_MAX_EDGES} relationships`);
		}
		return relationships;
	}

	private dependencyIds(id: string): string[] {
		const ids = this.relationships(id)
			.filter((edge) => edge.relation === "depends_on" && edge.from === id)
			.map((edge) => edge.to);
		if (ids.length > TASK_EXECUTION_MAX_DEGREE) {
			throw new Error(`task "${id}" exceeds ${TASK_EXECUTION_MAX_DEGREE} prerequisites`);
		}
		return ids;
	}

	private finish(id: string, gates: GateResult[]): TaskCompletion {
		const successorIds = this.relationships(id)
			.filter((edge) => edge.relation === "depends_on" && edge.to === id)
			.map((edge) => edge.from);
		if (successorIds.length > TASK_EXECUTION_MAX_DEGREE) {
			throw new Error(`task "${id}" exceeds ${TASK_EXECUTION_MAX_DEGREE} successors`);
		}
		const artifact = this.artifacts.setStatus(id, "done")!;
		const started: Artifact[] = [];
		const blocked: TaskBlockage[] = [];
		for (const successorId of successorIds) {
			const successor = this.require(successorId);
			if (successor.status !== "pending") continue;
			const dependencyIds = this.dependencyIds(successorId)
				.filter((dependencyId) => this.require(dependencyId).status !== "done");
			if (dependencyIds.length > 0) {
				blocked.push({ artifact: successor, dependencyIds });
				continue;
			}
			started.push(this.artifacts.setStatus(successorId, "active")!);
		}
		return { artifact, gates, completed: true, started, blocked };
	}

	private requireActive(id: string): Artifact {
		const task = this.require(id);
		if (task.status !== "active") throw new Error(`cannot complete task from ${task.status}`);
		return task;
	}
}
