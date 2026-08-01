import {
	type AppendTaskEvent,
	normalizeTaskEventFeedQuery,
	normalizeTaskHistoryQuery,
	type TaskEvent,
	type TaskEventFeedPage,
	type TaskEventFeedQuery,
	type TaskHistoryPage,
	type TaskHistoryQuery,
	validateTaskEvent,
} from "../domain/task-event.ts";

export interface TaskEventStore {
	atomic<T>(operation: () => T): T;
	append(event: AppendTaskEvent): TaskEvent;
	history(taskId: string, query?: TaskHistoryQuery): TaskHistoryPage;
	/** Bounded, sequenced, cross-task replay feed -- see TaskEventFeedQuery. */
	feed(query?: TaskEventFeedQuery): TaskEventFeedPage;
}

export class InMemoryTaskEventStore implements TaskEventStore {
	private events: TaskEvent[] = [];
	private nextId = 1;

	atomic<T>(operation: () => T): T {
		const length = this.events.length;
		const nextId = this.nextId;
		try {
			return operation();
		} catch (error) {
			this.events.length = length;
			this.nextId = nextId;
			throw error;
		}
	}

	append(event: AppendTaskEvent): TaskEvent {
		const stored: TaskEvent = {
			...validateTaskEvent(event),
			id: this.nextId++,
			occurredAt: new Date().toISOString(),
			schemaVersion: 1,
		};
		this.events.push(stored);
		return stored;
	}

	history(taskId: string, query: TaskHistoryQuery = {}): TaskHistoryPage {
		const { direction, limit, cursor } = normalizeTaskHistoryQuery(query);
		const ordered = this.events
			.filter(
				(event) => event.taskId === taskId && (cursor === undefined || (direction === "desc" ? event.id < cursor : event.id > cursor)),
			)
			.sort((left, right) => (direction === "desc" ? right.id - left.id : left.id - right.id));
		const events = ordered.slice(0, limit);
		return { events, ...(ordered.length > limit ? { nextCursor: events.at(-1)!.id } : {}) };
	}

	feed(query: TaskEventFeedQuery = {}): TaskEventFeedPage {
		const { limit, cursor, eventTypes } = normalizeTaskEventFeedQuery(query);
		const types = eventTypes ? new Set(eventTypes) : undefined;
		const ordered = this.events
			.filter((event) => (cursor === undefined || event.id > cursor) && (types === undefined || types.has(event.type)))
			.sort((left, right) => left.id - right.id);
		const events = ordered.slice(0, limit);
		return { events, ...(ordered.length > limit ? { nextCursor: events.at(-1)!.id } : {}) };
	}
}
