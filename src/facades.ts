import type { Db } from "./db.ts";
import {
	createArtifact,
	getArtifact,
	linkArtifacts,
	queryArtifacts,
	runGates,
	runGatesAsync,
	updateStatus,
	type Artifact,
	type Gate,
	type GateResult,
} from "./ops.ts";

export interface ListFilter {
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
	checklist?: unknown[];
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

const TASK_TRANSITIONS: Record<TaskTransition, { from: string[]; to: string }> = {
	start: { from: ["pending"], to: "active" },
	fail: { from: ["pending", "active"], to: "failed" },
	retry: { from: ["failed"], to: "pending" },
};

function requireKind(db: Db, id: string, kind: string): Artifact {
	const artifact = getArtifact(db, id);
	if (!artifact) throw new Error(`${kind} artifact "${id}" not found`);
	if (artifact.kind !== kind) throw new Error(`artifact "${id}" is not a ${kind}`);
	return artifact;
}

export function createTask(db: Db, input: CreateTaskInput): Artifact {
	if (input.parentId) requireKind(db, input.parentId, "task");
	for (const dependency of input.dependsOn ?? []) requireKind(db, dependency, "task");

	const extra: Record<string, unknown> = { ...(input.extra ?? {}) };
	if (input.gates !== undefined) extra["gates"] = input.gates;
	if (input.checklist !== undefined) extra["checklist"] = input.checklist;
	const task = createArtifact(db, {
		kind: "task",
		title: input.title,
		body: input.body,
		status: input.status,
		labels: input.labels,
		extra,
		templateId: input.templateId,
	});
	if (input.parentId) {
		linkArtifacts(db, input.parentId, "contains", task.id);
		linkArtifacts(db, task.id, "part_of", input.parentId);
	}
	for (const dependency of input.dependsOn ?? []) {
		linkArtifacts(db, task.id, "depends_on", dependency);
	}
	return getArtifact(db, task.id, { tree: true })!;
}

export function listTasks(db: Db, filter: ListFilter): Artifact[] {
	return queryArtifacts(db, { kind: "task", ...filter });
}

export function showTask(db: Db, id: string): Artifact {
	requireKind(db, id, "task");
	return getArtifact(db, id, { tree: true })!;
}

export function transitionTask(db: Db, id: string, action: TaskTransition): Artifact {
	const task = requireKind(db, id, "task");
	const transition = TASK_TRANSITIONS[action];
	if (!transition.from.includes(task.status)) {
		throw new Error(`cannot ${action} task from ${task.status}`);
	}
	return updateStatus(db, id, transition.to)!;
}

export function completeTask(db: Db, id: string): TaskCompletion {
	const task = requireKind(db, id, "task");
	if (task.status !== "active") throw new Error(`cannot complete task from ${task.status}`);
	const gates = runGates(db, id);
	if (gates.some((gate) => !gate.passed)) return { artifact: task, gates, completed: false };
	return { artifact: updateStatus(db, id, "done")!, gates, completed: true };
}

/** Daemon-safe completion: subprocess gates yield to the event loop. */
export async function completeTaskAsync(db: Db, id: string): Promise<TaskCompletion> {
	const task = requireKind(db, id, "task");
	if (task.status !== "active") throw new Error(`cannot complete task from ${task.status}`);
	const gates = await runGatesAsync(db, id);
	if (gates.some((gate) => !gate.passed)) return { artifact: requireKind(db, id, "task"), gates, completed: false };
	const current = requireKind(db, id, "task");
	if (current.status !== "active") throw new Error(`task changed to ${current.status} while gates were running`);
	return { artifact: updateStatus(db, id, "done")!, gates, completed: true };
}

export function linkTaskDependency(db: Db, id: string, dependencyId: string): Artifact {
	requireKind(db, id, "task");
	requireKind(db, dependencyId, "task");
	linkArtifacts(db, id, "depends_on", dependencyId);
	return showTask(db, id);
}

export function containTask(db: Db, parentId: string, childId: string): Artifact {
	requireKind(db, parentId, "task");
	requireKind(db, childId, "task");
	linkArtifacts(db, parentId, "contains", childId);
	linkArtifacts(db, childId, "part_of", parentId);
	return showTask(db, parentId);
}

export interface CreateDocumentInput {
	title: string;
	body?: string;
	subtype?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
	templateId?: string;
}

export type DocumentTransition = "activate" | "archive" | "reopen";
export type DocumentRelation = "references" | "documents" | "supersedes" | "relates_to" | "contains" | "part_of";

const DOCUMENT_TRANSITIONS: Record<DocumentTransition, { from: string[]; to: string }> = {
	activate: { from: ["draft"], to: "active" },
	archive: { from: ["draft", "active"], to: "archived" },
	reopen: { from: ["archived"], to: "draft" },
};

export function createDocument(db: Db, input: CreateDocumentInput): Artifact {
	return createArtifact(db, {
		kind: "doc",
		title: input.title,
		body: input.body,
		subtype: input.subtype,
		labels: input.labels,
		extra: input.extra,
		templateId: input.templateId,
	});
}

export function listDocuments(db: Db, filter: ListFilter): Artifact[] {
	return queryArtifacts(db, { kind: "doc", ...filter });
}

export function showDocument(db: Db, id: string): Artifact {
	requireKind(db, id, "doc");
	return getArtifact(db, id, { tree: true })!;
}

export function transitionDocument(db: Db, id: string, action: DocumentTransition): Artifact {
	const document = requireKind(db, id, "doc");
	const transition = DOCUMENT_TRANSITIONS[action];
	if (!transition.from.includes(document.status)) {
		throw new Error(`cannot ${action} document from ${document.status}`);
	}
	return updateStatus(db, id, transition.to)!;
}

export function linkDocument(db: Db, id: string, relation: DocumentRelation, targetId: string): Artifact {
	requireKind(db, id, "doc");
	if (!getArtifact(db, targetId)) throw new Error(`target artifact "${targetId}" not found`);
	linkArtifacts(db, id, relation, targetId);
	return showDocument(db, id);
}
