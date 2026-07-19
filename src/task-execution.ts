import { TASK_EXECUTION_MAX_DEGREE, TASK_EXECUTION_MAX_EDGES, TASK_EXECUTION_MAX_NODES } from "./constants.ts";
import type { TaskGraph } from "./task-service.ts";

export type TaskExecutionState =
	| "todo"
	| "in-progress"
	| "review"
	| "rejected"
	| "done"
	| "canceled"
	| "ready"
	| "blocked"
	| "invalid";

export interface TaskExecutionNode {
	id: string;
	title: string;
	status: string;
	active: boolean;
	state: TaskExecutionState;
	layer: number | null;
	prerequisiteIds: string[];
	successorIds: string[];
}

export interface TaskExecutionPlan {
	nodes: TaskExecutionNode[];
	layers: string[][];
	cycleIds: string[];
}

function executionState(status: string, invalid: boolean, prerequisitesDone: boolean): TaskExecutionState {
	if (invalid) return "invalid";
	if (status === "todo") return prerequisitesDone ? "ready" : "blocked";
	if (["in-progress", "review", "rejected", "done", "canceled"].includes(status)) {
		return status as TaskExecutionState;
	}
	return "blocked";
}

function assertBounds(graph: TaskGraph): void {
	if (graph.nodes.length > TASK_EXECUTION_MAX_NODES) {
		throw new Error(`task execution graph exceeds ${TASK_EXECUTION_MAX_NODES} nodes`);
	}
	for (const node of graph.nodes) {
		if (node.dependencyIds.length > TASK_EXECUTION_MAX_DEGREE) {
			throw new Error(`task "${node.task.id}" exceeds ${TASK_EXECUTION_MAX_DEGREE} prerequisites`);
		}
	}
	const edgeCount = graph.nodes.reduce((count, node) => count + node.dependencyIds.length, 0);
	if (edgeCount > TASK_EXECUTION_MAX_EDGES) {
		throw new Error(`task execution graph exceeds ${TASK_EXECUTION_MAX_EDGES} dependency edges`);
	}
}

/** Build deterministic topological layers ordered by creation time and task ID. */
export function projectTaskExecution(graph: TaskGraph): TaskExecutionPlan {
	assertBounds(graph);
	const orderedNodes = [...graph.nodes].sort((left, right) =>
		left.task.created_at.localeCompare(right.task.created_at) || left.task.id.localeCompare(right.task.id));
	const byId = new Map(orderedNodes.map((node) => [node.task.id, node]));
	const order = new Map(orderedNodes.map((node, index) => [node.task.id, index]));
	const successors = new Map(orderedNodes.map((node) => [node.task.id, [] as string[]]));
	const inDegree = new Map<string, number>();

	for (const node of orderedNodes) {
		const prerequisites = node.dependencyIds.filter((id) => byId.has(id));
		inDegree.set(node.task.id, prerequisites.length);
		for (const prerequisiteId of prerequisites) {
			const dependentIds = successors.get(prerequisiteId)!;
			if (dependentIds.length >= TASK_EXECUTION_MAX_DEGREE) {
				throw new Error(`task "${prerequisiteId}" exceeds ${TASK_EXECUTION_MAX_DEGREE} successors`);
			}
			dependentIds.push(node.task.id);
		}
	}

	let current = orderedNodes.filter((node) => inDegree.get(node.task.id) === 0).map((node) => node.task.id);
	const layers: string[][] = [];
	const processed = new Set<string>();
	const layerById = new Map<string, number>();
	while (current.length > 0) {
		const layer = [...current].sort((left, right) => order.get(left)! - order.get(right)!);
		layers.push(layer);
		const next: string[] = [];
		for (const id of layer) {
			processed.add(id);
			layerById.set(id, layers.length - 1);
			for (const successorId of successors.get(id) ?? []) {
				const remaining = inDegree.get(successorId)! - 1;
				inDegree.set(successorId, remaining);
				if (remaining === 0) next.push(successorId);
			}
		}
		current = next;
	}

	const cycleIds = orderedNodes.map((node) => node.task.id).filter((id) => !processed.has(id));
	const cycleSet = new Set(cycleIds);
	return {
		layers,
		cycleIds,
		nodes: orderedNodes.map((node) => {
			const prerequisiteIds = node.dependencyIds.filter((id) => byId.has(id));
			const prerequisitesDone = prerequisiteIds.every((id) => byId.get(id)!.task.status === "done");
			const state = executionState(node.task.status, cycleSet.has(node.task.id), prerequisitesDone);
			return {
				id: node.task.id,
				title: node.task.title,
				status: node.task.status,
				active: node.active === true,
				state,
				layer: layerById.get(node.task.id) ?? null,
				prerequisiteIds,
				successorIds: successors.get(node.task.id) ?? [],
			};
		}),
	};
}

/** Reject a dependency edge when the prerequisite already reaches the dependent. */
export function assertDependencyEdgeAllowed(graph: TaskGraph, id: string, dependencyId: string): void {
	assertBounds(graph);
	if (id === dependencyId) throw new Error(`task "${id}" cannot depend on itself`);
	const byId = new Map(graph.nodes.map((node) => [node.task.id, node]));
	if (!byId.has(id) || !byId.has(dependencyId)) throw new Error("dependency endpoints must be present in the task graph");

	const pending = [dependencyId];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (current === id) throw new Error(`dependency cycle: "${id}" cannot depend on "${dependencyId}"`);
		if (visited.has(current)) continue;
		visited.add(current);
		for (const prerequisiteId of byId.get(current)?.dependencyIds ?? []) pending.push(prerequisiteId);
	}
}
