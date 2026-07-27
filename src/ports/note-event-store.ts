import {
	normalizeNoteHistoryQuery,
	validateNoteEvent,
	type AppendNoteEvent,
	type NoteEvent,
	type NoteHistoryPage,
	type NoteHistoryQuery,
} from "../domain/note-event.ts";

export interface NoteEventStore {
	append(event: AppendNoteEvent): NoteEvent;
	history(noteId: string, query?: NoteHistoryQuery): NoteHistoryPage;
}

export class InMemoryNoteEventStore implements NoteEventStore {
	private events: NoteEvent[] = [];
	private nextId = 1;

	append(event: AppendNoteEvent): NoteEvent {
		const stored: NoteEvent = {
			...validateNoteEvent(event),
			id: this.nextId++,
			occurredAt: new Date().toISOString(),
			schemaVersion: 1,
		};
		this.events.push(stored);
		return stored;
	}

	history(noteId: string, query: NoteHistoryQuery = {}): NoteHistoryPage {
		const { direction, limit, cursor } = normalizeNoteHistoryQuery(query);
		const ordered = this.events
			.filter((event) => event.noteId === noteId && (cursor === undefined || (direction === "desc" ? event.id < cursor : event.id > cursor)))
			.sort((left, right) => direction === "desc" ? right.id - left.id : left.id - right.id);
		const events = ordered.slice(0, limit);
		return { events, ...(ordered.length > limit ? { nextCursor: events.at(-1)!.id } : {}) };
	}
}
