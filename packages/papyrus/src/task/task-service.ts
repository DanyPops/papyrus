import { createHash } from "node:crypto";
import type { Artifact } from "../artifact/artifact.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import {
	TASK_BODY_MAX_LENGTH,
	TASK_CANCEL_SUBTREE_MAX_NODES,
	TASK_CREATE_IDEMPOTENCY_KEY_MAX_LENGTH,
	TASK_CREATE_IDEMPOTENCY_RETENTION_MS,
	TASK_EXECUTION_MAX_DEGREE,
	TASK_EXECUTION_MAX_EDGES,
	TASK_EXECUTION_MAX_NODES,
	TASK_LABEL_MAX_COUNT,
	TASK_LABEL_MAX_LENGTH,
	TASK_SCOPE_MAX_TASKS,
	TASK_TITLE_MAX_LENGTH,
} from "../constants.ts";
import { DISCUSSION_SUBTYPE, isDiscussionArtifact, readDiscussionExtra } from "../discussion/discussion.ts";
import type { TransitionTable } from "../domain-service-shared.ts";
import { type Gate, type GateResult, validateGates } from "../gate/gate.ts";
import type { GateRunner } from "../gate/gate-runner.ts";
import { type Checklist, checklistEntries, type ProofReference, validateChecklist } from "./checklist.ts";
import {
	InMemoryTaskCreateRequestStore,
	TaskCreateIdempotencyConflictError,
	type TaskCreateRequestStore,
} from "./create-request/task-create-request-store.ts";
import type {
	AppendTaskEvent,
	TaskEventContext,
	TaskEventFeedPage,
	TaskEventFeedQuery,
	TaskHistoryPage,
	TaskHistoryQuery,
	TaskLifecycleStatus,
} from "./event/task-event.ts";
import { validateEventContext } from "./event/task-event.ts";
import { InMemoryTaskEventStore, type TaskEventStore } from "./event/task-event-store.ts";
import { InMemoryTaskFocusStore, type TaskFocusStatus, type TaskFocusStore } from "./focus/task-focus-store.ts";
import type { TaskLeaseView } from "./lease/task-lease.ts";
import { InMemoryTaskLeaseStore, type TaskLeaseStore } from "./lease/task-lease-store.ts";
import {
	InMemoryTaskMutationRequestStore,
	TaskMutationPendingError,
	type TaskMutationRequestRecord,
	type TaskMutationRequestStore,
} from "./mutation-request/task-mutation-request-store.ts";
import {
	normalizeProjectRoot,
	type RegisterTaskProjectInput,
	type TaskProject,
	type TaskScopeSource,
	type TaskViewMode,
	type TaskViewSelection,
	taskScopeLabel,
} from "./scope/task-scope.ts";
import { InMemoryTaskScopeStore, type TaskScopeStore } from "./scope/task-scope-store.ts";
import { TaskEdges } from "./task-edges.ts";
import { TaskExecutionBoundExceededError } from "./task-execution.ts";
import { type TaskFocus, TaskFocusCoordinator, type TaskFocusMutationResult } from "./task-focus-coordinator.ts";
import { TaskLeaseCoordinator } from "./task-lease-coordinator.ts";
import { TaskInvalidTransitionError } from "./task-lifecycle-errors.ts";
import {
	TaskMutationCoordinator,
	TaskMutationReceiptNotFoundError,
	type TaskMutationReceiptView,
	type TaskMutationRequestContext,
} from "./task-mutation-coordinator.ts";
import { TaskProjectAmbiguousError, TaskProjectNotFoundError, TaskProjectScope } from "./task-project-scope.ts";

export {
	type TaskFocus,
	type TaskFocusMutationResult,
	TaskInvalidTransitionError,
	TaskMutationReceiptNotFoundError,
	type TaskMutationReceiptView,
	type TaskMutationRequestContext,
	TaskProjectAmbiguousError,
	TaskProjectNotFoundError,
};

export interface UpdateTaskInput {
	title?: string;
	body?: string;
	labels?: string[];
	status?: "todo";
}

export interface TaskFilter {
	status?: string;
	text?: string;
	limit?: number;
	projectRoot?: string;
	scope?: TaskViewMode;
	rootTaskId?: string;
	/** Requesting agent session id — scopes Task Focus reads so concurrent agents see only their own Focus. Defaults to a shared "global" scope when omitted. */
	sessionId?: string;
	/** AND semantics: a task must carry every requested label, matching ArtifactStore.query's own labels filter. */
	labels?: string[];
}

export type TaskStatus = TaskLifecycleStatus;

export interface TaskMutationMetadata {
	changed: boolean;
	operation: string;
	currentStatus: string;
	intendedStatus: string;
	receiptId?: string;
	replayed?: boolean;
}

export type TaskLifecycleMutationResult = Artifact & TaskMutationMetadata;

export interface CreateTaskRequestContext {
	key?: string;
	caller?: string;
}

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
	projectRoot?: string;
	projectSource?: TaskScopeSource;
}

export type TaskTransition = "start" | "submit" | "reject" | "retry" | "cancel" | "reopen";

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

export interface TaskCompletionOptions {
	focusSuccessor?: boolean;
	gateDeadlineMs?: number;
}

export interface TaskCompletion extends TaskMutationMetadata {
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
	focusStatus?: TaskFocusStatus;
	parentIds: string[];
	childIds: string[];
	dependencyIds: string[];
}

export interface TaskGraph {
	nodes: TaskNode[];
	rootIds: string[];
	scope?: TaskViewSelection;
}

const TASK_TRANSITIONS: TransitionTable<TaskTransition, TaskStatus> = {
	start: { from: ["todo"], to: "in-progress" },
	submit: { from: ["in-progress"], to: "review" },
	reject: { from: ["review"], to: "rejected" },
	retry: { from: ["rejected"], to: "in-progress" },
	cancel: { from: ["todo", "in-progress", "review", "rejected"], to: "canceled" },
	/**
	 * Distinct from tasks.update's status:todo path (recoverCreation, below): that path only ever
	 * recovers a task whose entire history is a single "created" event already at a terminal status
	 * (a creation-time mistake) -- it deliberately refuses a task that reached canceled through a
	 * real, later transition. reopen is the missing counterpart for exactly that case: a task
	 * legitimately canceled (e.g. a deliberate "pause/park", since there is no direct
	 * in-progress -> todo transition) can be brought back to todo and driven through the normal
	 * lifecycle again, without rewriting its real history the way recoverCreation's own
	 * terminal-at-creation check exists to prevent.
	 */
	reopen: { from: ["canceled"], to: "todo" },
};

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export class Tasks {
	constructor(
		private readonly artifacts: ArtifactStore,
		private readonly gates: GateRunner,
		private readonly focusStore: TaskFocusStore = new InMemoryTaskFocusStore(),
		private readonly events: TaskEventStore = new InMemoryTaskEventStore(),
		private readonly scopes: TaskScopeStore = new InMemoryTaskScopeStore(),
		private readonly leases: TaskLeaseStore = new InMemoryTaskLeaseStore(),
		private readonly createRequests: TaskCreateRequestStore = new InMemoryTaskCreateRequestStore(),
		private readonly mutationRequests: TaskMutationRequestStore = new InMemoryTaskMutationRequestStore(),
	) {
		this.leaseCoordinator = new TaskLeaseCoordinator(this.leases, (id) => this.require(id));
		this.mutationCoordinator = new TaskMutationCoordinator(this.mutationRequests, this.artifacts);
		this.focusCoordinator = new TaskFocusCoordinator(
			this.artifacts,
			this.focusStore,
			this.events,
			this.mutationCoordinator,
			(id) => this.require(id),
			(filter) => this.list(filter),
			(event, context) => this.appendEvent(event, context),
		);
		this.projectScope = new TaskProjectScope(
			this.scopes,
			this.events,
			(id) => this.require(id),
			(event, context) => this.appendEvent(event, context),
		);
		this.taskEdges = new TaskEdges(
			this.artifacts,
			this.events,
			(id) => this.require(id),
			(id) => this.show(id),
			(event, context) => this.appendEvent(event, context),
			(id, dependencyId) => this.dependencyCheckGraph(id, dependencyId),
			(id) => this.dependencyIds(id),
			(id) => this.relationships(id),
		);
	}

	private readonly completionFlights = new Map<string, Promise<TaskCompletion>>();
	private readonly leaseCoordinator: TaskLeaseCoordinator;
	private readonly mutationCoordinator: TaskMutationCoordinator;
	private readonly focusCoordinator: TaskFocusCoordinator;
	private readonly projectScope: TaskProjectScope;
	private readonly taskEdges: TaskEdges;

	private require(id: string): Artifact {
		const artifact = this.artifacts.get(id);
		if (!artifact) throw new Error(`task artifact "${id}" not found`);
		if (artifact.kind !== "task") throw new Error(`artifact "${id}" is not a task`);
		return artifact;
	}

	create(input: CreateTaskInput, context: TaskEventContext = {}, request: CreateTaskRequestContext = {}): Artifact {
		return this.events.atomic(() => {
			const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
			const key = request.key?.trim();
			if (request.key !== undefined && (!key || key.length > TASK_CREATE_IDEMPOTENCY_KEY_MAX_LENGTH)) {
				throw new Error(`idempotency key must be between 1 and ${TASK_CREATE_IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
			}
			const now = new Date().toISOString();
			const scope = `${request.caller?.trim() || "anonymous"}\u0000${projectRoot ?? "unscoped"}`;
			const requestHash = key
				? createHash("sha256")
						.update(canonicalJson({ ...input, projectRoot }))
						.digest("hex")
				: undefined;
			if (key && requestHash) {
				this.createRequests.prune(now);
				const replay = this.createRequests.get(scope, key, now);
				if (replay) {
					if (replay.requestHash !== requestHash) {
						throw new TaskCreateIdempotencyConflictError(`idempotency key "${key}" was already used with a different task payload`);
					}
					return JSON.parse(replay.responseJson) as Artifact;
				}
			}
			if ((input.dependsOn?.length ?? 0) > TASK_EXECUTION_MAX_DEGREE) {
				throw new Error(`task cannot exceed ${TASK_EXECUTION_MAX_DEGREE} prerequisites`);
			}
			if (input.parentId) this.require(input.parentId);
			for (const dependency of input.dependsOn ?? []) this.require(dependency);
			const extra: Record<string, unknown> = { ...(input.extra ?? {}) };
			if (input.gates !== undefined) extra.gates = validateGates(input.gates);
			if (input.checklist !== undefined) extra.checklist = validateChecklist(input.checklist);
			if (input.parentId && this.scopes.get(input.parentId)?.projectRoot !== projectRoot) {
				throw new Error(`parent task "${input.parentId}" is outside project scope`);
			}
			const task = this.artifacts.create({
				id: input.id,
				kind: "task",
				title: input.title,
				body: input.body,
				subtype: input.subtype,
				status: input.status ?? "todo",
				labels: input.labels,
				extra,
				templateId: input.templateId,
			});
			this.scopes.assign(task.id, projectRoot, input.projectSource ?? (projectRoot ? "explicit" : "unscoped"));
			if (input.parentId) this.contain(input.parentId, task.id);
			for (const dependency of input.dependsOn ?? []) this.depend(task.id, dependency);
			this.appendEvent({ taskId: task.id, type: "created", toStatus: task.status as TaskStatus }, context);
			const created = this.show(task.id);
			if (key && requestHash) {
				this.createRequests.put({
					scope,
					key,
					requestHash,
					responseJson: JSON.stringify(created),
					createdAt: now,
					expiresAt: new Date(Date.parse(now) + TASK_CREATE_IDEMPOTENCY_RETENTION_MS).toISOString(),
				});
			}
			return created;
		});
	}

	private recoverCreation(id: string, context: TaskEventContext): Artifact {
		if (!context.reason?.trim()) throw new Error("creation recovery requires an audit reason");
		return this.events.atomic(() => {
			const task = this.require(id);
			if (task.status !== "done" && task.status !== "canceled") throw new Error(`cannot recover task creation from ${task.status}`);
			const history = this.events.history(id, { direction: "asc", limit: 2 });
			const created = history.events[0];
			if (
				history.events.length !== 1 ||
				history.nextCursor !== undefined ||
				created?.type !== "created" ||
				created.toStatus !== task.status
			) {
				throw new Error("task was not terminal at creation");
			}
			const recovered = this.artifacts.setStatus(id, "todo");
			if (!recovered) throw new Error(`task "${id}" not found`);
			this.appendEvent(
				{
					taskId: id,
					type: "creation_recovered",
					fromStatus: task.status as TaskStatus,
					toStatus: "todo",
					evidence: { result: "terminal-at-creation" },
				},
				context,
			);
			return recovered;
		});
	}

	update(id: string, input: UpdateTaskInput, context: TaskEventContext = {}): Artifact {
		if (input.status !== undefined) {
			if (input.status !== "todo") throw new Error("task status updates only support recovering creation to todo");
			if (input.title !== undefined || input.body !== undefined || input.labels !== undefined) {
				throw new Error("task creation recovery cannot be combined with content updates");
			}
			return this.recoverCreation(id, context);
		}
		const fields = (["title", "body", "labels"] as const).filter((field) => input[field] !== undefined);
		if (fields.length === 0)
			throw new Error("task update requires title, body, or labels; status todo is only valid for creation recovery");
		if (input.title !== undefined && (input.title.trim().length === 0 || input.title.length > TASK_TITLE_MAX_LENGTH)) {
			throw new Error(`title must be between 1 and ${TASK_TITLE_MAX_LENGTH} characters`);
		}
		if (input.body !== undefined && input.body.length > TASK_BODY_MAX_LENGTH)
			throw new Error(`body cannot exceed ${TASK_BODY_MAX_LENGTH} characters`);
		if (input.labels !== undefined) {
			if (input.labels.length > TASK_LABEL_MAX_COUNT) throw new Error(`labels cannot exceed ${TASK_LABEL_MAX_COUNT} entries`);
			if (input.labels.some((label) => label.length === 0 || label.length > TASK_LABEL_MAX_LENGTH)) {
				throw new Error(`each label must be between 1 and ${TASK_LABEL_MAX_LENGTH} characters`);
			}
		}
		return this.events.atomic(() => {
			this.require(id);
			const updated = this.artifacts.updateContent(id, input);
			if (!updated) throw new Error(`task "${id}" not found`);
			this.appendEvent({ taskId: id, type: "updated", evidence: { result: `fields:${fields.sort().join(",")}` } }, context);
			return updated;
		});
	}

	list(filter: TaskFilter = {}): Artifact[] {
		const selection = this.projectScope.scopeSelection(filter.projectRoot, filter.scope, filter.rootTaskId);
		const limit = filter.limit ?? TASK_SCOPE_MAX_TASKS;
		if (!Number.isInteger(limit) || limit < 1 || limit > TASK_SCOPE_MAX_TASKS + 1) {
			throw new Error(`task list limit must be between 1 and ${TASK_SCOPE_MAX_TASKS + 1}`);
		}
		if (selection.mode === "all") {
			return this.artifacts.query({
				kind: "task",
				excludeSubtype: DISCUSSION_SUBTYPE,
				status: filter.status,
				text: filter.text,
				labels: filter.labels,
				limit,
			});
		}
		const ids = this.scopes.taskIds(selection.projectRoot, TASK_SCOPE_MAX_TASKS + 1);
		if (ids.length > TASK_SCOPE_MAX_TASKS) throw new Error(`task project scope exceeds ${TASK_SCOPE_MAX_TASKS} tasks`);
		const selectedIds = selection.mode === "graph" ? this.descendantIds(selection.rootTaskId!, ids) : new Set(ids);
		const text = filter.text?.toLowerCase();
		const labels = filter.labels ?? [];
		// query(), unlike get(), excludes trash by default -- a trashed task's id stays in
		// task_scopes until the retention window actually purges it, so building this candidate
		// set from get() per id (deliberately trash-transparent, for show/restore) would otherwise
		// leak a trashed task back into list results for the entire grace period. Scoped by ids
		// rather than a bare kind query, so this stays bounded to exactly the already-bounded
		// selectedIds set instead of scanning every task in the database.
		const notTrashed = new Map(
			this.artifacts.query({ kind: "task", excludeSubtype: DISCUSSION_SUBTYPE, ids: [...selectedIds] }).map((task) => [task.id, task]),
		);
		return [...selectedIds]
			.map((id) => notTrashed.get(id))
			.filter((task): task is Artifact => task !== undefined)
			.filter((task) => filter.status === undefined || task.status === filter.status)
			.filter((task) => text === undefined || task.title.toLowerCase().includes(text) || task.body.toLowerCase().includes(text))
			.filter((task) => labels.every((label) => task.labels.includes(label)))
			.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
			.slice(0, limit);
	}

	scopeSelection(projectRoot?: string, mode?: TaskViewMode, rootTaskId?: string): TaskViewSelection {
		return this.projectScope.scopeSelection(projectRoot, mode, rootTaskId);
	}

	setView(projectRoot: string, mode: TaskViewMode, rootTaskId?: string): TaskViewSelection {
		return this.projectScope.setView(projectRoot, mode, rootTaskId);
	}

	assignProject(id: string, projectRoot: string, context: TaskEventContext = {}): Artifact {
		return this.projectScope.assignProject(id, projectRoot, context);
	}

	graph(filter: TaskFilter = {}): TaskGraph {
		const scope = this.projectScope.scopeSelection(filter.projectRoot, filter.scope, filter.rootTaskId);
		const requestedLimit = filter.limit ?? TASK_EXECUTION_MAX_NODES + 1;
		if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > TASK_EXECUTION_MAX_NODES + 1) {
			throw new Error(`task graph limit must be between 1 and ${TASK_EXECUTION_MAX_NODES + 1}`);
		}
		const tasks = this.list({ ...filter, limit: requestedLimit });
		return this.buildGraph(tasks, scope, filter.sessionId);
	}

	/** Shared by graph() and dependencyCheckGraph() -- the latter builds a graph from an
	 * explicitly assembled task list (a union of two projects) rather than one filter's own scope. */
	private buildGraph(tasks: Artifact[], scope: TaskViewSelection, sessionId?: string): TaskGraph {
		if (tasks.length > TASK_EXECUTION_MAX_NODES) {
			throw new TaskExecutionBoundExceededError(`task execution graph exceeds ${TASK_EXECUTION_MAX_NODES} nodes`);
		}
		const byId = new Map(tasks.map((task) => [task.id, task]));
		const focus = this.focusStore.get(sessionId);
		const focusedId = focus?.taskId;
		const focusStatus = focus?.status;
		const nodes = new Map(
			tasks.map((task) => [
				task.id,
				{
					task,
					active: task.id === focusedId,
					...(task.id === focusedId ? { focusStatus } : {}),
					parentIds: [] as string[],
					childIds: [] as string[],
					dependencyIds: [] as string[],
				},
			]),
		);
		const relationships = this.artifacts.relationships({
			kind: "task",
			artifactIds: [...byId.keys()],
			limit: TASK_EXECUTION_MAX_EDGES + 1,
		});
		if (relationships.length > TASK_EXECUTION_MAX_EDGES) {
			throw new TaskExecutionBoundExceededError(`task execution graph exceeds ${TASK_EXECUTION_MAX_EDGES} relationships`);
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
			scope,
		};
	}

	projects(query?: string, limit = 20): TaskProject[] {
		return this.projectScope.projects(query, limit);
	}

	resolveProject(reference: string): TaskProject {
		return this.projectScope.resolveProject(reference);
	}

	registerProject(input: RegisterTaskProjectInput, existingReference?: string): TaskProject {
		return this.projectScope.registerProject(input, existingReference);
	}

	show(id: string): Artifact {
		this.require(id);
		return this.artifacts.get(id, { tree: true })!;
	}

	focused(filter?: TaskFilter): TaskFocus | null {
		return this.focusCoordinator.focused(filter);
	}

	active(filter?: TaskFilter): Artifact | null {
		return this.focusCoordinator.active(filter);
	}

	focus(id: string, context: TaskEventContext = {}): Artifact {
		return this.focusCoordinator.focus(id, context);
	}

	pauseFocus(context: TaskEventContext = {}, request: TaskMutationRequestContext = {}): TaskFocusMutationResult {
		return this.focusCoordinator.pauseFocus(context, request);
	}

	unpauseFocus(context: TaskEventContext = {}, request: TaskMutationRequestContext = {}): TaskFocusMutationResult {
		return this.focusCoordinator.unpauseFocus(context, request);
	}

	clearFocus(context: TaskEventContext = {}): { cleared: boolean } {
		return this.focusCoordinator.clearFocus(context);
	}

	/** Delegates to TaskFocusCoordinator -- see its own doc comment on TASK_FOCUS_STALE_AFTER_MS/TASK_FOCUS_MAX_SCOPES. */
	reapStaleFocus(now?: () => string): number {
		return this.focusCoordinator.reapStaleFocus(now);
	}

	/** A lease is orthogonal to lifecycle and Focus: claiming a task does not start it, and does not require it to be Focused. */
	claimLease(id: string, owner: string, ttlMs?: number, note?: string): TaskLeaseView {
		return this.leaseCoordinator.claim(id, owner, ttlMs, note);
	}

	heartbeatLease(id: string, owner: string, token: string, ttlMs?: number): TaskLeaseView {
		return this.leaseCoordinator.heartbeat(id, owner, token, ttlMs);
	}

	/** Idempotent for an already-absent or already-expired lease, matching undepend/uncontain's precedent -- never throws merely because there was nothing left to release. */
	releaseLease(id: string, owner: string, token: string): { released: boolean } {
		return this.leaseCoordinator.release(id, owner, token);
	}

	getLease(id: string): TaskLeaseView | undefined {
		return this.leaseCoordinator.get(id);
	}

	reapStaleLeases(now: () => string = () => new Date().toISOString()): number {
		return this.leaseCoordinator.reapStale(now);
	}

	private allowedLifecycleActions(status: string): string[] {
		const actions = Object.entries(TASK_TRANSITIONS)
			.filter(([, transition]) => transition.from.includes(status as TaskStatus))
			.map(([action]) => action);
		if (status === "review") actions.push("complete");
		return actions;
	}

	private prepareMutation<Result>(
		operation: string,
		taskId: string | undefined,
		payload: unknown,
		request: TaskMutationRequestContext,
		reserve = true,
		validate?: () => void,
	): { record?: TaskMutationRequestRecord; replay?: Result; pending?: boolean } {
		return this.mutationCoordinator.prepare<Result>(operation, taskId, payload, request, reserve, validate);
	}

	private rejectDifferentPendingMutation(taskId: string, operation: string, inspectionPending: boolean): void {
		this.mutationCoordinator.rejectDifferentPending(taskId, operation, inspectionPending);
	}

	private completeMutation<Result>(record: TaskMutationRequestRecord | undefined, result: Result): Result {
		return this.mutationCoordinator.complete(record, result);
	}

	mutationStatus(keyInput: string, caller?: string): TaskMutationReceiptView {
		return this.mutationCoordinator.status(keyInput, caller);
	}

	transition(
		id: string,
		action: TaskTransition,
		context: TaskEventContext = {},
		request: TaskMutationRequestContext = {},
	): TaskLifecycleMutationResult {
		const task = this.require(id);
		const intendedStatus = TASK_TRANSITIONS[action].to;
		const inspection = this.prepareMutation<TaskLifecycleMutationResult>(action, id, context, request, false);
		if (inspection.replay) return inspection.replay;
		this.rejectDifferentPendingMutation(id, action, inspection.pending === true);
		if (task.status !== intendedStatus && !TASK_TRANSITIONS[action].from.includes(task.status as TaskStatus)) {
			throw new TaskInvalidTransitionError(
				action,
				task.status,
				intendedStatus,
				this.allowedLifecycleActions(task.status),
				`Call tasks.show, then choose one allowed action; do not retry ${action} with a new key.`,
			);
		}
		if (action === "start" && task.status !== intendedStatus) {
			const blocking = this.dependencyIds(id)
				.map((dependencyId) => this.require(dependencyId))
				.filter((dependency) => dependency.status !== "done");
			if (blocking.length > 0) {
				throw new Error(
					`task "${task.title}" is blocked by dependencies: ${blocking.map((dependency) => `"${dependency.title}"`).join(", ")}`,
				);
			}
		}
		const prepared = inspection.pending
			? inspection
			: this.prepareMutation<TaskLifecycleMutationResult>(action, id, context, request, true, () => validateEventContext(context));
		if (task.status === intendedStatus) {
			return this.completeMutation(prepared.record, {
				...this.show(id),
				changed: false,
				operation: action,
				currentStatus: intendedStatus,
				intendedStatus,
				...(prepared.record ? { receiptId: prepared.record.receiptId } : {}),
			});
		}
		return this.events.atomic(() => {
			if (action === "start") this.focusStore.set(id, context.sessionId);
			const artifact = this.artifacts.setStatus(id, intendedStatus)!;
			const eventType = {
				start: "started",
				submit: "submitted",
				reject: "review_rejected",
				retry: "retried",
				cancel: "canceled",
				reopen: "reopened",
			}[action] as AppendTaskEvent["type"];
			this.appendEvent({ taskId: id, type: eventType, fromStatus: task.status as TaskStatus, toStatus: intendedStatus }, context);
			if (action === "start" || action === "retry") this.propagateProgressToAncestors(id, context);
			if (action === "retry") this.focusStore.set(id, context.sessionId);
			if (action === "cancel") this.focusStore.clearEverywhere(id);
			return this.completeMutation(prepared.record, {
				...artifact,
				changed: true,
				operation: action,
				currentStatus: intendedStatus,
				intendedStatus,
				...(prepared.record ? { receiptId: prepared.record.receiptId } : {}),
			});
		});
	}

	/**
	 * Cancels a task and every task in its containment subtree (`contains` edges, transitively) --
	 * a whole materialized playbook run can be torn down in one call instead of enumerating
	 * every task id by hand. A task already in a terminal state (done/canceled) is skipped, not
	 * treated as an error, matching how a mixed-status subtree is the normal case (some steps
	 * genuinely finished before the rest needed to be abandoned). Does not follow `depends_on` --
	 * only containment cascades, a prerequisite is a different unit of work.
	 */
	cancelSubtree(id: string, context: TaskEventContext = {}): { canceled: string[]; skipped: string[] } {
		this.require(id);
		const visited = new Set<string>();
		const queue = [id];
		const canceled: string[] = [];
		const skipped: string[] = [];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (visited.has(current)) continue;
			visited.add(current);
			if (visited.size > TASK_CANCEL_SUBTREE_MAX_NODES) throw new Error(`cancelSubtree exceeds ${TASK_CANCEL_SUBTREE_MAX_NODES} tasks`);
			const task = this.artifacts.get(current);
			if (task?.kind !== "task") continue;
			const childIds = this.artifacts
				.relationships({ artifactIds: [current] })
				.filter((edge) => edge.from === current && edge.relation === "contains")
				.map((edge) => edge.to);
			queue.push(...childIds);
			if (task.status === "done" || task.status === "canceled") {
				skipped.push(current);
				continue;
			}
			this.transition(current, "cancel", context);
			canceled.push(current);
		}
		return { canceled, skipped };
	}

	complete(
		id: string,
		context: TaskEventContext = {},
		options: TaskCompletionOptions = {},
		request: TaskMutationRequestContext = {},
	): TaskCompletion {
		const task = this.require(id);
		const inspection = this.prepareMutation<TaskCompletion>("complete", id, { context, options }, request, false);
		if (inspection.replay) return inspection.replay;
		this.rejectDifferentPendingMutation(id, "complete", inspection.pending === true);
		if (inspection.pending) {
			throw new TaskMutationPendingError(
				"completion outcome is still pending; inspect tasks.mutation_status and tasks.show before choosing another action",
				inspection.record!.receiptId,
				"complete",
			);
		}
		if (task.status !== "review" && task.status !== "done") this.throwInvalidCompletion(task.status);
		if (task.status === "review") this.requireNotBlocked(task);
		const prepared = this.prepareMutation<TaskCompletion>("complete", id, { context, options }, request, true, () =>
			validateEventContext(context),
		);
		if (task.status === "done") return this.completeMutation(prepared.record, this.completedNoop(id, context, prepared.record));
		const attemptId = prepared.record?.receiptId ?? crypto.randomUUID();
		this.events.atomic(() =>
			this.appendEvent({ taskId: id, type: "completion_attempted", fromStatus: "review", toStatus: "review", attemptId }, context),
		);
		const checklist = this.reviewChecklist(task);
		const results = this.gates.run(id, { cwd: this.scopes.get(id)?.projectRoot });
		return this.resolveCompletion(id, attemptId, results, checklist, context, options, prepared.record);
	}

	async completeAsync(
		id: string,
		context: TaskEventContext = {},
		options: TaskCompletionOptions = {},
		request: TaskMutationRequestContext = {},
	): Promise<TaskCompletion> {
		const flightKey = id;
		const existingFlight = this.completionFlights.get(flightKey);
		if (existingFlight) {
			await existingFlight;
			return this.completeAsync(id, context, options, request);
		}
		const execute = async (): Promise<TaskCompletion> => {
			const task = this.require(id);
			const inspection = this.prepareMutation<TaskCompletion>("complete", id, { context, options }, request, false);
			if (inspection.replay) return inspection.replay;
			this.rejectDifferentPendingMutation(id, "complete", inspection.pending === true);
			if (inspection.pending) {
				throw new TaskMutationPendingError(
					"completion outcome is still pending; inspect tasks.mutation_status and tasks.show before choosing another action",
					inspection.record!.receiptId,
					"complete",
				);
			}
			if (task.status !== "review" && task.status !== "done") this.throwInvalidCompletion(task.status);
			if (task.status === "review") this.requireNotBlocked(task);
			const prepared = this.prepareMutation<TaskCompletion>("complete", id, { context, options }, request, true, () =>
				validateEventContext(context),
			);
			if (task.status === "done") return this.completeMutation(prepared.record, this.completedNoop(id, context, prepared.record));
			const attemptId = prepared.record?.receiptId ?? crypto.randomUUID();
			this.events.atomic(() =>
				this.appendEvent({ taskId: id, type: "completion_attempted", fromStatus: "review", toStatus: "review", attemptId }, context),
			);
			const checklist = this.reviewChecklist(task);
			// project_root, never the daemon's own inherited process cwd -- see GateRunOptions.cwd's doc
			// comment for the real incident this fixes (a command gate once tested the daemon's entire
			// home directory instead of the task's project and crashed the bun process outright).
			const results = await this.gates.runAsync(id, { deadlineMs: options.gateDeadlineMs, cwd: this.scopes.get(id)?.projectRoot });
			const latest = this.require(id);
			if (latest.status !== "review") this.throwInvalidCompletion(latest.status);
			return this.resolveCompletion(id, attemptId, results, checklist, context, options, prepared.record);
		};
		const flight = execute();
		this.completionFlights.set(flightKey, flight);
		try {
			return await flight;
		} finally {
			this.completionFlights.delete(flightKey);
		}
	}

	async runGates(id: string, context: TaskEventContext = {}): Promise<GateResult[]> {
		this.require(id);
		const results = await this.gates.runAsync(id, { cwd: this.scopes.get(id)?.projectRoot });
		this.events.atomic(() =>
			this.appendEvent(
				{
					taskId: id,
					type: "gates_evaluated",
					evidence: { gates: results, result: results.every((gate) => gate.passed) ? "passed" : "failed" },
				},
				context,
			),
		);
		return results;
	}

	history(id: string, query: TaskHistoryQuery = {}): TaskHistoryPage {
		this.require(id);
		return this.events.history(id, query);
	}

	/** Bounded, sequenced, cross-task replay feed -- see TaskEventFeedQuery. Not scoped to any one task, unlike history(). */
	eventFeed(query: TaskEventFeedQuery = {}): TaskEventFeedPage {
		return this.events.feed(query);
	}

	setChecklist(id: string, checklist: Checklist): Artifact {
		const task = this.require(id);
		return this.artifacts.setExtra(id, { ...task.extra, checklist: validateChecklist(checklist) })!;
	}

	/**
	 * The only way to change a task's gates after creation. "tasks update" (title/body/labels/
	 * status only) silently ignored a `gates` field with no error at all -- a real incident (see
	 * GateRunOptions.cwd's doc comment for the crash this masked while debugging).
	 */
	setGates(id: string, gates: Gate[]): Artifact {
		const task = this.require(id);
		return this.artifacts.setExtra(id, { ...task.extra, gates: validateGates(gates) })!;
	}

	depend(id: string, dependencyId: string, context: TaskEventContext = {}): Artifact {
		return this.taskEdges.depend(id, dependencyId, context);
	}

	/**
	 * Scopes the cycle-check graph to the two endpoints' shared project when they have one, instead
	 * of building the whole daemon's graph -- a small project's own dependency check must never fail
	 * just because unrelated tasks in other projects pushed the daemon-wide total over
	 * TASK_EXECUTION_MAX_NODES. Falls back to the unscoped graph when the endpoints don't share a
	 * known project (a genuine cross-project dependency), preserving the prior, correct behavior for
	 * that rarer case.
	 */
	private dependencyCheckGraph(id: string, dependencyId: string): TaskGraph {
		const sourceProject = this.scopes.get(id)?.projectRoot;
		const targetProject = this.scopes.get(dependencyId)?.projectRoot;
		if (sourceProject !== undefined && sourceProject === targetProject) {
			return this.graph({ projectRoot: sourceProject, scope: "project" });
		}
		if (sourceProject !== undefined && targetProject !== undefined) {
			// A genuine cross-project pair: the union of both endpoints' own project scopes
			// covers every prerequisite/successor edge relevant to THIS pair's own cycle check,
			// without pulling in every unrelated project's tasks -- those can push the daemon-wide
			// total over TASK_EXECUTION_MAX_NODES for reasons that have nothing to do with these
			// two tasks. A cycle threading through a third, uninvolved project is not covered by
			// this union; falls back to the fully unscoped graph only when a project is unknown.
			const limit = TASK_EXECUTION_MAX_NODES + 1;
			const merged = new Map(this.list({ projectRoot: sourceProject, scope: "project", limit }).map((task) => [task.id, task]));
			for (const task of this.list({ projectRoot: targetProject, scope: "project", limit })) merged.set(task.id, task);
			return this.buildGraph([...merged.values()], { mode: "all", label: taskScopeLabel("all") });
		}
		return this.graph();
	}

	/** Idempotent: undepending an already-absent dependency is a no-op. Never starts, completes, or focuses work — only removes the edge. */
	undepend(id: string, dependencyId: string, context: TaskEventContext = {}): Artifact {
		return this.taskEdges.undepend(id, dependencyId, context);
	}

	contain(parentId: string, childId: string, context: TaskEventContext = {}): Artifact {
		return this.taskEdges.contain(parentId, childId, context);
	}

	/** Idempotent: removing an already-absent containment is a no-op. Both contains/part_of edges are removed atomically. */
	uncontain(parentId: string, childId: string, context: TaskEventContext = {}): Artifact {
		return this.taskEdges.uncontain(parentId, childId, context);
	}

	private descendantIds(rootTaskId: string, projectTaskIds: string[]): Set<string> {
		const allowed = new Set(projectTaskIds);
		if (!allowed.has(rootTaskId)) throw new Error(`task "${rootTaskId}" is outside project scope`);
		const relationships = this.artifacts.relationships({
			kind: "task",
			artifactIds: projectTaskIds,
			limit: TASK_EXECUTION_MAX_EDGES + 1,
		});
		if (relationships.length > TASK_EXECUTION_MAX_EDGES)
			throw new Error(`task project scope exceeds ${TASK_EXECUTION_MAX_EDGES} relationships`);
		const children = new Map<string, string[]>();
		for (const edge of relationships) {
			const parentId = edge.relation === "contains" ? edge.from : edge.relation === "part_of" ? edge.to : undefined;
			const childId = edge.relation === "contains" ? edge.to : edge.relation === "part_of" ? edge.from : undefined;
			if (!parentId || !childId || !allowed.has(parentId) || !allowed.has(childId)) continue;
			const values = children.get(parentId) ?? [];
			if (!values.includes(childId)) values.push(childId);
			children.set(parentId, values);
		}
		const selected = new Set<string>();
		const pending = [rootTaskId];
		while (pending.length > 0) {
			const id = pending.shift()!;
			if (selected.has(id)) continue;
			if (selected.size >= TASK_SCOPE_MAX_TASKS) throw new Error(`focused task graph exceeds ${TASK_SCOPE_MAX_TASKS} tasks`);
			selected.add(id);
			pending.push(...(children.get(id) ?? []));
		}
		return selected;
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
				this.appendEvent(
					{ taskId: parentId, type: "started", fromStatus: "todo", toStatus: "in-progress" },
					{
						...context,
						source: "task-ancestry",
						reason: `nested task ${id} entered progress`,
					},
				);
			}
			pending.push(...this.parentIds(parentId));
		}
	}

	private reviewChecklist(task: Artifact): ChecklistReview[] {
		return checklistEntries(task.extra.checklist).map((entry) => ({
			item: entry.item,
			proof: entry.proof,
			accepted: !entry.legacy && entry.proof.length > 0,
			...(entry.legacy || entry.proof.length === 0 ? { reason: "typed proof reference required" } : {}),
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

	private throwInvalidCompletion(currentStatus: string): never {
		throw new TaskInvalidTransitionError(
			"complete",
			currentStatus,
			"done",
			this.allowedLifecycleActions(currentStatus),
			"Call tasks.show, then choose an allowed action. Reuse the original idempotency_key only when recovering an unknown completion outcome.",
		);
	}

	private completedNoop(id: string, context: TaskEventContext, record?: TaskMutationRequestRecord): TaskCompletion {
		return {
			artifact: this.show(id),
			gates: [],
			checklist: this.reviewChecklist(this.require(id)),
			completed: true,
			focused: this.active({ sessionId: context.sessionId }),
			blocked: [],
			changed: false,
			operation: "complete",
			currentStatus: "done",
			intendedStatus: "done",
			...(record ? { receiptId: record.receiptId } : {}),
		};
	}

	private resolveCompletion(
		id: string,
		attemptId: string,
		gates: GateResult[],
		checklist: ChecklistReview[],
		context: TaskEventContext,
		options: TaskCompletionOptions,
		record?: TaskMutationRequestRecord,
	): TaskCompletion {
		const failed = gates.some((gate) => !gate.passed) || checklist.some((item) => !item.accepted);
		if (failed) {
			return this.events.atomic(() => {
				const artifact = this.artifacts.setStatus(id, "rejected")!;
				this.appendEvent(
					{
						taskId: id,
						type: "review_rejected",
						fromStatus: "review",
						toStatus: "rejected",
						attemptId,
						evidence: { gates, checklist, result: "rejected" },
					},
					context,
				);
				return this.completeMutation(record, {
					artifact,
					gates,
					checklist,
					completed: false,
					focused: this.active({ sessionId: context.sessionId }),
					blocked: [],
					changed: true,
					operation: "complete",
					currentStatus: "rejected",
					intendedStatus: "done",
					...(record ? { receiptId: record.receiptId } : {}),
				});
			});
		}
		return this.events.atomic(() => {
			const result = this.finish(id, attemptId, gates, checklist, context, options, record?.receiptId);
			return this.completeMutation(record, result);
		});
	}

	private finish(
		id: string,
		attemptId: string,
		gates: GateResult[],
		checklist: ChecklistReview[],
		context: TaskEventContext,
		options: TaskCompletionOptions,
		receiptId?: string,
	): TaskCompletion {
		const successorIds = this.relationships(id)
			.filter((edge) => edge.relation === "depends_on" && edge.to === id)
			.map((edge) => edge.from);
		if (successorIds.length > TASK_EXECUTION_MAX_DEGREE) {
			throw new Error(`task "${id}" exceeds ${TASK_EXECUTION_MAX_DEGREE} successors`);
		}
		const artifact = this.artifacts.setStatus(id, "done")!;
		this.appendEvent(
			{
				taskId: id,
				type: "completed",
				fromStatus: "review",
				toStatus: "done",
				attemptId,
				evidence: { gates, checklist, result: "completed" },
			},
			context,
		);
		this.focusStore.clearEverywhere(id);
		const blocked: TaskBlockage[] = [];
		let focused: Artifact | null = null;
		for (const successorId of [...successorIds].sort()) {
			const successor = this.require(successorId);
			if (successor.status === "done" || successor.status === "canceled") continue;
			const dependencyIds = this.dependencyIds(successorId).filter((dependencyId) => this.require(dependencyId).status !== "done");
			if (dependencyIds.length > 0) {
				blocked.push({ artifact: successor, dependencyIds });
				continue;
			}
			// Every successor whose last unmet dependency was this completion, not only the one
			// auto-focused below -- readiness is a real state change for all of them.
			this.appendEvent({ taskId: successor.id, type: "became_ready" }, context);
			if (options.focusSuccessor !== false && !focused) {
				this.focusStore.set(successor.id, context.sessionId);
				focused = successor;
			}
		}
		return {
			artifact,
			gates,
			checklist,
			completed: true,
			focused,
			blocked,
			changed: true,
			operation: "complete",
			currentStatus: "done",
			intendedStatus: "done",
			...(receiptId ? { receiptId } : {}),
		};
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

	/**
	 * Discuss's forcing behavior (see discussions/discussion.ts): an active Discussion doc that
	 * `blocks` this task refuses its completion until settled or deferred. A discussion whose
	 * extra.discussion shape is missing or corrupt is treated as non-blocking rather than
	 * crashing completion -- the same fail-open posture Task Focus's opt-in armor uses for an
	 * unrecognized shape.
	 */
	private blockingDiscussions(id: string): Artifact[] {
		return this.artifacts
			.relationships({ artifactIds: [id] })
			.filter((edge) => edge.relation === "blocks" && edge.to === id)
			.map((edge) => this.artifacts.get(edge.from))
			.filter((source): source is Artifact => source !== null && isDiscussionArtifact(source))
			.filter((discussion) => {
				try {
					return readDiscussionExtra(discussion.extra).state === "active";
				} catch {
					return false;
				}
			});
	}

	private requireNotBlocked(task: Artifact): void {
		const blockers = this.blockingDiscussions(task.id);
		if (blockers.length > 0) {
			throw new Error(
				`task "${task.title}" is blocked by ${blockers.length} active Discussion(s): ${blockers.map((discussion) => `"${discussion.title}"`).join(", ")}`,
			);
		}
	}
}
