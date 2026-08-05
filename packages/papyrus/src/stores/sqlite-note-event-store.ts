import type { Db } from "../db.ts";
import {
	type AppendNoteEvent,
	type NoteEvent,
	type NoteEventType,
	type NoteHistoryPage,
	type NoteHistoryQuery,
	normalizeNoteHistoryQuery,
	validateNoteEvent,
} from "../domain/note-event.ts";
import type { NoteEventStore } from "./note-event-store.ts";

interface NoteEventRow {
	id: number;
	note_id: string;
	occurred_at: string;
	event_type: NoteEventType;
	actor: string;
	source: string;
	session_id: string | null;
	reason: string | null;
	related_id: string | null;
	disposition: string | null;
	event_schema_version: 1;
}

function mapRow(row: NoteEventRow): NoteEvent {
	return {
		id: row.id,
		noteId: row.note_id,
		occurredAt: row.occurred_at,
		type: row.event_type,
		actor: row.actor,
		source: row.source,
		...(row.session_id === null ? {} : { sessionId: row.session_id }),
		...(row.reason === null ? {} : { reason: row.reason }),
		...(row.related_id === null ? {} : { relatedId: row.related_id }),
		...(row.disposition === null ? {} : { disposition: row.disposition }),
		schemaVersion: row.event_schema_version,
	};
}

export class SQLiteNoteEventStore implements NoteEventStore {
	constructor(private readonly db: Db) {}

	append(input: AppendNoteEvent): NoteEvent {
		const event = validateNoteEvent(input);
		const result = this.db
			.prepare(`
			INSERT INTO note_events (
				note_id, occurred_at, event_type, actor, source, session_id, reason, related_id, disposition, event_schema_version
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		`)
			.run(
				event.noteId,
				new Date().toISOString(),
				event.type,
				event.actor,
				event.source,
				event.sessionId ?? null,
				event.reason ?? null,
				event.relatedId ?? null,
				event.disposition ?? null,
			);
		return mapRow(this.db.prepare("SELECT * FROM note_events WHERE id = ?").get(result.lastInsertRowid) as NoteEventRow);
	}

	history(noteId: string, query: NoteHistoryQuery = {}): NoteHistoryPage {
		const { limit, direction, cursor } = normalizeNoteHistoryQuery(query);
		const comparator = direction === "desc" ? "<" : ">";
		const order = direction === "desc" ? "DESC" : "ASC";
		const rows = this.db
			.prepare(`
			SELECT * FROM note_events
			WHERE note_id = ? ${cursor === undefined ? "" : `AND id ${comparator} ?`}
			ORDER BY occurred_at ${order}, id ${order}
			LIMIT ?
		`)
			.all(...(cursor === undefined ? [noteId, limit + 1] : [noteId, cursor, limit + 1])) as NoteEventRow[];
		const hasMore = rows.length > limit;
		const events = rows.slice(0, limit).map(mapRow);
		return { events, ...(hasMore ? { nextCursor: events.at(-1)!.id } : {}) };
	}
}
