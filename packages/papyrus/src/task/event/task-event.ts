import {
	TASK_EVENT_ACTOR_MAX_LENGTH,
	TASK_EVENT_FEED_DEFAULT_LIMIT,
	TASK_EVENT_FEED_MAX_LIMIT,
	TASK_EVENT_MAX_EVIDENCE_BYTES,
	TASK_EVENT_REASON_MAX_LENGTH,
	TASK_HISTORY_DEFAULT_LIMIT,
	TASK_HISTORY_MAX_LIMIT,
} from "../../constants.ts";
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
	"reopened",
	"dependency_added",
	"dependency_removed",
	"containment_added",
	"containment_removed",
	"became_ready",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];
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

/**
 * A bounded, sequenced, cross-task replay feed -- distinct from TaskHistoryQuery, which is
 * scoped to one task. A consumer resumes exactly where it left off via nextCursor rather than
 * re-scanning the whole graph; always ascending (a subscription only ever replays forward).
 */
export interface TaskEventFeedQuery {
	cursor?: number;
	limit?: number;
	eventTypes?: TaskEventType[];
}

export interface TaskEventFeedPage {
	events: TaskEvent[];
	nextCursor?: number;
}

export function normalizeTaskEventFeedQuery(
	query: TaskEventFeedQuery = {},
): Required<Pick<TaskEventFeedQuery, "limit">> & Pick<TaskEventFeedQuery, "cursor" | "eventTypes"> {
	const limit = query.limit ?? TASK_EVENT_FEED_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > TASK_EVENT_FEED_MAX_LIMIT) {
		throw new Error(`task event feed limit must be between 1 and ${TASK_EVENT_FEED_MAX_LIMIT}`);
	}
	if (query.cursor !== undefined && (!Number.isInteger(query.cursor) || query.cursor < 0)) {
		throw new Error("task event feed cursor must be a non-negative integer");
	}
	if (query.eventTypes !== undefined) {
		if (query.eventTypes.length === 0) throw new Error("task event feed eventTypes, if provided, must be non-empty");
		for (const type of query.eventTypes) {
			if (!TASK_EVENT_TYPES.includes(type)) throw new Error(`unknown task event type "${type}"`);
		}
	}
	return { limit, cursor: query.cursor, eventTypes: query.eventTypes };
}

export function normalizeTaskHistoryQuery(
	query: TaskHistoryQuery = {},
): Required<Pick<TaskHistoryQuery, "limit" | "direction">> & Pick<TaskHistoryQuery, "cursor"> {
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

/**
 * Validates just the caller-supplied context fields (sessionId/reason) that are already fully
 * known BEFORE a mutation method does anything else -- unlike actor/source (always filled with
 * defaults by appendEvent, never caller-controlled in practice) or evidence (often not known
 * until real work, e.g. gate results, has already happened). Exported specifically so a mutation
 * method can call it BEFORE reserving an idempotency receipt (see TaskMutationCoordinator.prepare's
 * own `validate` hook) rather than only discovering an invalid reason deep inside events.atomic(),
 * after a receipt was already durably written as pending -- a real incident (task a54f0649): a
 * validation failure that fires only after the reserve leaves that receipt permanently stuck,
 * since nothing else in the call ever reaches the code path that marks it complete.
 */
export function validateEventContext(context: Pick<TaskEventContext, "sessionId" | "reason">): void {
	if (context.sessionId !== undefined && context.sessionId.length > TASK_EVENT_ACTOR_MAX_LENGTH)
		throw new Error(`sessionId cannot exceed ${TASK_EVENT_ACTOR_MAX_LENGTH} characters`);
	if (context.reason !== undefined && context.reason.length > TASK_EVENT_REASON_MAX_LENGTH)
		throw new Error(`reason cannot exceed ${TASK_EVENT_REASON_MAX_LENGTH} characters`);
}

export function validateTaskEvent(event: AppendTaskEvent): AppendTaskEvent {
	for (const [field, value] of [
		["actor", event.actor],
		["source", event.source],
	] as const) {
		if (!value || value.length > TASK_EVENT_ACTOR_MAX_LENGTH)
			throw new Error(`${field} must be between 1 and ${TASK_EVENT_ACTOR_MAX_LENGTH} characters`);
	}
	validateEventContext(event);
	if (event.evidence !== undefined && new TextEncoder().encode(JSON.stringify(event.evidence)).byteLength > TASK_EVENT_MAX_EVIDENCE_BYTES) {
		throw new Error(`task event evidence cannot exceed ${TASK_EVENT_MAX_EVIDENCE_BYTES} bytes`);
	}
	return event;
}
