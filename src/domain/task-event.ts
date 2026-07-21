import {
	TASK_EVENT_ACTOR_MAX_LENGTH,
	TASK_EVENT_MAX_EVIDENCE_BYTES,
	TASK_EVENT_REASON_MAX_LENGTH,
	TASK_HISTORY_DEFAULT_LIMIT,
	TASK_HISTORY_MAX_LIMIT,
} from "../constants.ts";
export type TaskLifecycleStatus = "todo" | "in-progress" | "review" | "rejected" | "done" | "canceled";

export const TASK_EVENT_TYPES = [
	"created",
	"creation_recovered",
	"updated",
	"started",
	"submitted",
	"completion_attempted",
	"gates_evaluated",
	"focus_set",
	"focus_paused",
	"focus_unpaused",
	"focus_cleared",
	"project_assigned",
	"review_rejected",
	"retried",
	"completed",
	"canceled",
	"dependency_added",
	"dependency_removed",
	"containment_added",
	"containment_removed",
] as const;

export type TaskEventType = typeof TASK_EVENT_TYPES[number];
export type TaskEventDirection = "asc" | "desc";

export interface TaskEventContext {
	actor?: string;
	source?: string;
	sessionId?: string;
	reason?: string;
}

export interface TaskEventEvidence {
	gates?: unknown;
	checklist?: unknown;
	result?: string;
}

export interface TaskEvent {
	id: number;
	taskId: string;
	occurredAt: string;
	type: TaskEventType;
	actor: string;
	source: string;
	sessionId?: string;
	reason?: string;
	fromStatus?: TaskLifecycleStatus;
	toStatus?: TaskLifecycleStatus;
	attemptId?: string;
	evidence?: TaskEventEvidence;
	schemaVersion: 1;
}

export interface AppendTaskEvent {
	taskId: string;
	type: TaskEventType;
	actor: string;
	source: string;
	sessionId?: string;
	reason?: string;
	fromStatus?: TaskLifecycleStatus;
	toStatus?: TaskLifecycleStatus;
	attemptId?: string;
	evidence?: TaskEventEvidence;
}

export interface TaskHistoryQuery {
	limit?: number;
	cursor?: number;
	direction?: TaskEventDirection;
}

export interface TaskHistoryPage {
	events: TaskEvent[];
	nextCursor?: number;
}

export function normalizeTaskHistoryQuery(query: TaskHistoryQuery = {}): Required<Pick<TaskHistoryQuery, "limit" | "direction">> & Pick<TaskHistoryQuery, "cursor"> {
	const limit = query.limit ?? TASK_HISTORY_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > TASK_HISTORY_MAX_LIMIT) {
		throw new Error(`task history limit must be between 1 and ${TASK_HISTORY_MAX_LIMIT}`);
	}
	if (query.cursor !== undefined && (!Number.isInteger(query.cursor) || query.cursor < 1)) {
		throw new Error("task history cursor must be a positive integer");
	}
	if (query.direction !== undefined && query.direction !== "asc" && query.direction !== "desc") {
		throw new Error("task history direction must be asc or desc");
	}
	return { limit, direction: query.direction ?? "desc", ...(query.cursor === undefined ? {} : { cursor: query.cursor }) };
}

export function validateTaskEvent(event: AppendTaskEvent): AppendTaskEvent {
	for (const [field, value] of [["actor", event.actor], ["source", event.source]] as const) {
		if (!value || value.length > TASK_EVENT_ACTOR_MAX_LENGTH) throw new Error(`${field} must be between 1 and ${TASK_EVENT_ACTOR_MAX_LENGTH} characters`);
	}
	if (event.sessionId !== undefined && event.sessionId.length > TASK_EVENT_ACTOR_MAX_LENGTH) throw new Error(`sessionId cannot exceed ${TASK_EVENT_ACTOR_MAX_LENGTH} characters`);
	if (event.reason !== undefined && event.reason.length > TASK_EVENT_REASON_MAX_LENGTH) throw new Error(`reason cannot exceed ${TASK_EVENT_REASON_MAX_LENGTH} characters`);
	if (event.evidence !== undefined && new TextEncoder().encode(JSON.stringify(event.evidence)).byteLength > TASK_EVENT_MAX_EVIDENCE_BYTES) {
		throw new Error(`task event evidence cannot exceed ${TASK_EVENT_MAX_EVIDENCE_BYTES} bytes`);
	}
	return event;
}
