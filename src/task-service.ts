import { TASK_EXECUTION_MAX_DEGREE, TASK_EXECUTION_MAX_EDGES, TASK_EXECUTION_MAX_NODES } from "./constants.ts";
import type { Artifact } from "./domain/artifact.ts";
import { checklistEntries, validateChecklist, type Checklist, type ProofReference } from "./domain/checklist.ts";
import type { Gate, GateResult } from "./domain/gate.ts";
import type { AppendTaskEvent, TaskEventContext, TaskHistoryPage, TaskHistoryQuery, TaskLifecycleStatus } from "./domain/task-event.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { GateRunner } from "./ports/gate-runner.ts";
import { InMemoryTaskFocusStore, type TaskFocusStore } from "./ports/task-focus-store.ts";
import { InMemoryTaskEventStore, type TaskEventStore } from "./ports/task-event-store.ts";
import { assertDependencyEdgeAllowed } from "./task-execution.ts";

export interface TaskFilter {
	status?: string;
	text?: string;
	limit?: number;
}

export type TaskStatus = TaskLifecycleStatus;

export interface CreateTaskInput {
	id?: string;
	title: string;
	body?: string;
	subtype?: string;
	status?: TaskStatus;
	labels?: string[];
	extra?: Record<string, unknown>;
	gates?: Gate[];
	checklist?: Checklist;
	templateId?: string;
	parentId?: string;
	dependsOn?: string[];
}

export type TaskTransition = "start" | "submit" | "reject" | "retry" | "cancel";

export interface TaskBlockage {
	artifact: Artifact;
	dependencyIds: string[];
}

export interface ChecklistReview {
	item: string;
	proof: ProofReference[];
	accepted: boolean;
	reason?: string;
}

export interface TaskCompletion {
	artifact: Artifact;
	gates: GateResult[];
	checklist: ChecklistReview[];
	completed: boolean;
	focused: Artifact | null;
	blocked: TaskBlockage[];
}

export interface TaskNode {
	task: Artifact;
	active?: boolean;
	parentIds: string[];
	childIds: string[];
	dependencyIds: string[];
}

export interface TaskGraph {
	nodes: TaskNode[];
	rootIds: string[];
}

const TASK_TRANSITIONS: Record<TaskTransition, { from: TaskStatus[]; to: TaskStatus }> = {
	start: { from: ["todo"], to: "in-progress" },
	submit: { from: ["in-progress"], to: "review" },
	reject: { from: ["review"], to: "rejected" },
	retry: { from: ["rejected"], to: "in-progress" },
	cancel: { from: ["todo", "in-progress", "review", "rejected"], to: "canceled" },
};

export class Tasks {
	constructor(
		private readonly artifacts: ArtifactStore,
		private readonly gates: GateRunner,
		private readonly focusStore: TaskFocusStore = new InMemoryTaskFocusStore(),
		private readonly events: TaskEventStore = new InMemoryTaskEventStore(),
	) {}

	private require(id: string): Artifact {
		const artifact = this.artifacts.get(id);
		if (!artifact) throw new Error(`task artifact "${id}" not found`);
		if (artifact.kind !== "task") throw new Error(`artifact "${id}" is not a task`);
		return artifact;
	}

	create(input: CreateTaskInput, context: TaskEventContext = {}): Artifact {
		return this.events.atomic(() => {
			if ((input.dependsOn?.length ?? 0) > TASK_EXECUTION_MAX_DEGREE) {
				throw new Error(`task cannot exceed ${TASK_EXECUTION_MAX_DEGREE} prerequisites`);
			}
			if (input.parentId) this.require(input.parentId);
			for (const dependency of input.dependsOn ?? []) this.require(dependency);
			const extra: Record<string, unknown> = { ...(input.extra ?? {}) };
			if (input.gates !== undefined) extra["gates"] = input.gates;
			if (input.checklist !== undefined) extra["checklist"] = validateChecklist(input.checklist);
			const task = this.artifacts.create({
				id: input.id,
				kind: "task",
				title: input.title,
				body: input.body,
				subtype: input.subtype,
				status: input.status,
				labels: input.labels,
				extra,
				templateId: input.templateId,
			});
			if (input.parentId) this.contain(input.parentId, task.id);
			for (const dependency of input.dependsOn ?? []) this.depend(task.id, dependency);
			this.appendEvent({ taskId: task.id, type: "created", toStatus: task.status as TaskStatus }, context);
			return this.show(task.id);
		});
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
		const focusedId = this.focusStore.get();
		const nodes = new Map(tasks.map((task) => [task.id, {
			task,
			active: task.id === focusedId,
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

	active(): Artifact | null {
		const id = this.focusStore.get();
		if (!id) return null;
		const task = this.artifacts.get(id);
		if (!task || task.kind !== "task" || task.status === "done" || task.status === "canceled") {
			this.focusStore.clear(id);
			return null;
		}
		return task;
	}

	focus(id: string): Artifact {
		const task = this.require(id);
		if (task.status === "done" || task.status === "canceled") {
			throw new Error(`cannot focus task from ${task.status}`);
		}
		this.focusStore.set(id);
		return task;
	}

	transition(id: string, action: TaskTransition, context: TaskEventContext = {}): Artifact {
		return this.events.atomic(() => {
			const task = this.require(id);
			const transition = TASK_TRANSITIONS[action];
			if (!transition.from.includes(task.status as TaskStatus)) throw new Error(`cannot ${action} task from ${task.status}`);
			if (action === "start") {
				const blocking = this.dependencyIds(id).filter((dependencyId) => this.require(dependencyId).status !== "done");
				if (blocking.length > 0) throw new Error(`task "${id}" is blocked by dependencies: ${blocking.join(", ")}`);
				this.focusStore.set(id);
			}
			const updated = this.artifacts.setStatus(id, transition.to)!;
			const eventType = { start: "started", submit: "submitted", reject: "review_rejected", retry: "retried", cancel: "canceled" }[action] as AppendTaskEvent["type"];
			this.appendEvent({ taskId: id, type: eventType, fromStatus: task.status as TaskStatus, toStatus: transition.to }, context);
			if (action === "start" || action === "retry") this.propagateProgressToAncestors(id, context);
			if (action === "retry") this.focusStore.set(id);
			if (action === "cancel") this.focusStore.clear(id);
			return updated;
		});
	}

	complete(id: string, context: TaskEventContext = {}): TaskCompletion {
		const task = this.requireReview(id);
		const attemptId = crypto.randomUUID();
		this.events.atomic(() => this.appendEvent({ taskId: id, type: "completion_attempted", fromStatus: "review", toStatus: "review", attemptId }, context));
		const checklist = this.reviewChecklist(task);
		const results = this.gates.run(id);
		return this.resolveCompletion(id, attemptId, results, checklist, context);
	}

	async completeAsync(id: string, context: TaskEventContext = {}): Promise<TaskCompletion> {
		const task = this.requireReview(id);
		const attemptId = crypto.randomUUID();
		this.events.atomic(() => this.appendEvent({ taskId: id, type: "completion_attempted", fromStatus: "review", toStatus: "review", attemptId }, context));
		const checklist = this.reviewChecklist(task);
		const results = await this.gates.runAsync(id);
		this.requireReview(id);
		return this.resolveCompletion(id, attemptId, results, checklist, context);
	}

	async runGates(id: string, context: TaskEventContext = {}): Promise<GateResult[]> {
		this.require(id);
		const results = await this.gates.runAsync(id);
		this.events.atomic(() => this.appendEvent({ taskId: id, type: "gates_evaluated", evidence: { gates: results, result: results.every((gate) => gate.passed) ? "passed" : "failed" } }, context));
		return results;
	}

	history(id: string, query: TaskHistoryQuery = {}): TaskHistoryPage {
		this.require(id);
		return this.events.history(id, query);
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

	private parentIds(id: string): string[] {
		return this.relationships(id)
			.flatMap((edge) => {
				if (edge.relation === "part_of" && edge.from === id) return [edge.to];
				if (edge.relation === "contains" && edge.to === id) return [edge.from];
				return [];
			})
			.filter((parentId, index, ids) => ids.indexOf(parentId) === index);
	}

	private propagateProgressToAncestors(id: string, context: TaskEventContext): void {
		const pending = this.parentIds(id);
		const visited = new Set<string>();
		while (pending.length > 0) {
			const parentId = pending.shift()!;
			if (visited.has(parentId)) continue;
			if (visited.size >= TASK_EXECUTION_MAX_NODES) throw new Error("task ancestry exceeds execution node bound");
			visited.add(parentId);
			const parent = this.require(parentId);
			if (parent.status === "todo") {
				this.artifacts.setStatus(parentId, "in-progress");
				this.appendEvent({ taskId: parentId, type: "started", fromStatus: "todo", toStatus: "in-progress" }, {
					...context,
					source: "task-ancestry",
					reason: `nested task ${id} entered progress`,
				});
			}
			pending.push(...this.parentIds(parentId));
		}
	}

	private reviewChecklist(task: Artifact): ChecklistReview[] {
		return checklistEntries(task.extra["checklist"]).map((entry) => ({
			item: entry.item,
			proof: entry.proof,
			accepted: !entry.legacy && entry.proof.length > 0,
			...((entry.legacy || entry.proof.length === 0) ? { reason: "typed proof reference required" } : {}),
		}));
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

	private resolveCompletion(
		id: string,
		attemptId: string,
		gates: GateResult[],
		checklist: ChecklistReview[],
		context: TaskEventContext,
	): TaskCompletion {
		const failed = gates.some((gate) => !gate.passed) || checklist.some((item) => !item.accepted);
		if (failed) {
			return this.events.atomic(() => {
				const artifact = this.artifacts.setStatus(id, "rejected")!;
				this.appendEvent({
					taskId: id,
					type: "review_rejected",
					fromStatus: "review",
					toStatus: "rejected",
					attemptId,
					evidence: { gates, checklist, result: "rejected" },
				}, context);
				return { artifact, gates, checklist, completed: false, focused: this.active(), blocked: [] };
			});
		}
		return this.events.atomic(() => this.finish(id, attemptId, gates, checklist, context));
	}

	private finish(id: string, attemptId: string, gates: GateResult[], checklist: ChecklistReview[], context: TaskEventContext): TaskCompletion {
		const successorIds = this.relationships(id)
			.filter((edge) => edge.relation === "depends_on" && edge.to === id)
			.map((edge) => edge.from);
		if (successorIds.length > TASK_EXECUTION_MAX_DEGREE) {
			throw new Error(`task "${id}" exceeds ${TASK_EXECUTION_MAX_DEGREE} successors`);
		}
		const artifact = this.artifacts.setStatus(id, "done")!;
		this.appendEvent({
			taskId: id,
			type: "completed",
			fromStatus: "review",
			toStatus: "done",
			attemptId,
			evidence: { gates, checklist, result: "completed" },
		}, context);
		this.focusStore.clear(id);
		const blocked: TaskBlockage[] = [];
		let focused: Artifact | null = null;
		for (const successorId of [...successorIds].sort()) {
			const successor = this.require(successorId);
			if (successor.status === "done" || successor.status === "canceled") continue;
			const dependencyIds = this.dependencyIds(successorId)
				.filter((dependencyId) => this.require(dependencyId).status !== "done");
			if (dependencyIds.length > 0) {
				blocked.push({ artifact: successor, dependencyIds });
				continue;
			}
			if (!focused) {
				this.focusStore.set(successor.id);
				focused = successor;
			}
		}
		return { artifact, gates, checklist, completed: true, focused, blocked };
	}

	private appendEvent(event: Omit<AppendTaskEvent, "actor" | "source">, context: TaskEventContext): void {
		this.events.append({
			...event,
			actor: context.actor ?? "system",
			source: context.source ?? "task-domain",
			...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
			...(context.reason === undefined ? {} : { reason: context.reason }),
		});
	}

	private requireReview(id: string): Artifact {
		const task = this.require(id);
		if (task.status !== "review") throw new Error(`cannot complete task from ${task.status}`);
		return task;
	}
}
