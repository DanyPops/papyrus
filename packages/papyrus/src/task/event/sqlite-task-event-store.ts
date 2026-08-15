import type { Db } from "../../db.ts";
import { inTransaction } from "../../db.ts";
import {
	type AppendTaskEvent,
	normalizeTaskEventFeedQuery,
	normalizeTaskHistoryQuery,
	type TaskEvent,
	type TaskEventEvidence,
	type TaskEventFeedPage,
	type TaskEventFeedQuery,
	type TaskEventType,
	type TaskHistoryPage,
	type TaskHistoryQuery,
	type TaskLifecycleStatus,
	validateTaskEvent,
} from "./task-event.ts";
import type { TaskEventStore } from "./task-event-store.ts";

interface TaskEventRow {
	id: number;
	task_id: string;
	occurred_at: string;
	event_type: TaskEventType;
	actor: string;
	source: string;
	session_id: string | null;
	reason: string | null;
	from_status: TaskLifecycleStatus | null;
	to_status: TaskLifecycleStatus | null;
	attempt_id: string | null;
	evidence_json: string | null;
	event_schema_version: 1;
}

function mapRow(row: TaskEventRow): TaskEvent {
	return {
		id: row.id,
		taskId: row.task_id,
		occurredAt: row.occurred_at,
		type: row.event_type,
		actor: row.actor,
		source: row.source,
		...(row.session_id === null ? {} : { sessionId: row.session_id }),
		...(row.reason === null ? {} : { reason: row.reason }),
		...(row.from_status === null ? {} : { fromStatus: row.from_status }),
		...(row.to_status === null ? {} : { toStatus: row.to_status }),
		...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
		...(row.evidence_json === null ? {} : { evidence: JSON.parse(row.evidence_json) as TaskEventEvidence }),
		schemaVersion: row.event_schema_version,
	};
}

export class SQLiteTaskEventStore implements TaskEventStore {
	constructor(private readonly db: Db) {}

	atomic<T>(operation: () => T): T {
		return inTransaction(this.db, operation);
	}

	append(input: AppendTaskEvent): TaskEvent {
		const event = validateTaskEvent(input);
		const result = this.db
			.prepare(`
			INSERT INTO task_events (
				task_id, occurred_at, event_type, actor, source, session_id, reason,
				from_status, to_status, attempt_id, evidence_json, event_schema_version
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		`)
			.run(
				event.taskId,
				new Date().toISOString(),
				event.type,
				event.actor,
				event.source,
				event.sessionId ?? null,
				event.reason ?? null,
				event.fromStatus ?? null,
				event.toStatus ?? null,
				event.attemptId ?? null,
				event.evidence === undefined ? null : JSON.stringify(event.evidence),
			);
		return mapRow(this.db.prepare("SELECT * FROM task_events WHERE id = ?").get(result.lastInsertRowid) as TaskEventRow);
	}

	history(taskId: string, query: TaskHistoryQuery = {}): TaskHistoryPage {
		const { limit, direction, cursor } = normalizeTaskHistoryQuery(query);
		const comparator = direction === "desc" ? "<" : ">";
		const order = direction === "desc" ? "DESC" : "ASC";
		const rows = this.db
			.prepare(`
			SELECT * FROM task_events
			WHERE task_id = ? ${cursor === undefined ? "" : `AND id ${comparator} ?`}
			ORDER BY occurred_at ${order}, id ${order}
			LIMIT ?
		`)
			.all(...(cursor === undefined ? [taskId, limit + 1] : [taskId, cursor, limit + 1])) as TaskEventRow[];
		const hasMore = rows.length > limit;
		const events = rows.slice(0, limit).map(mapRow);
		return { events, ...(hasMore ? { nextCursor: events.at(-1)!.id } : {}) };
	}

	feed(query: TaskEventFeedQuery = {}): TaskEventFeedPage {
		const { limit, cursor, eventTypes } = normalizeTaskEventFeedQuery(query);
		const typeFilter = eventTypes ? `AND event_type IN (${eventTypes.map(() => "?").join(", ")})` : "";
		const params: unknown[] = [];
		if (cursor !== undefined) params.push(cursor);
		if (eventTypes) params.push(...eventTypes);
		params.push(limit + 1);
		const rows = this.db
			.prepare(`
			SELECT * FROM task_events
			WHERE 1=1 ${cursor === undefined ? "" : "AND id > ?"} ${typeFilter}
			ORDER BY id ASC
			LIMIT ?
		`)
			.all(...params) as TaskEventRow[];
		const hasMore = rows.length > limit;
		const events = rows.slice(0, limit).map(mapRow);
		return { events, ...(hasMore ? { nextCursor: events.at(-1)!.id } : {}) };
	}
}
