/**
 * Notes' own append-only event log, mirroring task-event.ts's proven shape. Replaces the
 * previous extra.noteHistory: a bounded array inside a mutable JSON field, which a later
 * setExtra from a concurrent operation could overwrite -- a real record can't do that.
 */
import {
	NOTE_HISTORY_DEFAULT_LIMIT,
	NOTE_HISTORY_MAX_LIMIT,
	NOTE_PROVENANCE_MAX_LENGTH,
	NOTE_REASON_MAX_CHARACTERS,
} from "../constants.ts";

export const NOTE_EVENT_TYPES = ["captured", "consumed", "promoted", "archived"] as const;
export type NoteEventType = (typeof NOTE_EVENT_TYPES)[number];
export type NoteEventDirection = "asc" | "desc";

export interface NoteEvent {
	id: number;
	noteId: string;
	occurredAt: string;
	type: NoteEventType;
	actor: string;
	source: string;
	sessionId?: string;
	reason?: string;
	/** Promotion target, when type is "promoted". */
	relatedId?: string;
	/** Archive disposition, or "promoted" -- mirrors the summary already kept at extra.disposition. */
	disposition?: string;
	schemaVersion: 1;
}

export interface AppendNoteEvent {
	noteId: string;
	type: NoteEventType;
	actor: string;
	source: string;
	sessionId?: string;
	reason?: string;
	relatedId?: string;
	disposition?: string;
}

export interface NoteHistoryQuery {
	limit?: number;
	cursor?: number;
	direction?: NoteEventDirection;
}

export interface NoteHistoryPage {
	events: NoteEvent[];
	nextCursor?: number;
}

export function normalizeNoteHistoryQuery(
	query: NoteHistoryQuery = {},
): Required<Pick<NoteHistoryQuery, "limit" | "direction">> & Pick<NoteHistoryQuery, "cursor"> {
	const limit = query.limit ?? NOTE_HISTORY_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > NOTE_HISTORY_MAX_LIMIT) {
		throw new Error(`note history limit must be between 1 and ${NOTE_HISTORY_MAX_LIMIT}`);
	}
	if (query.cursor !== undefined && (!Number.isInteger(query.cursor) || query.cursor < 1)) {
		throw new Error("note history cursor must be a positive integer");
	}
	if (query.direction !== undefined && query.direction !== "asc" && query.direction !== "desc") {
		throw new Error("note history direction must be asc or desc");
	}
	return { limit, direction: query.direction ?? "desc", ...(query.cursor === undefined ? {} : { cursor: query.cursor }) };
}

export function validateNoteEvent(event: AppendNoteEvent): AppendNoteEvent {
	for (const [field, value] of [
		["actor", event.actor],
		["source", event.source],
	] as const) {
		if (!value || value.length > NOTE_PROVENANCE_MAX_LENGTH)
			throw new Error(`${field} must be between 1 and ${NOTE_PROVENANCE_MAX_LENGTH} characters`);
	}
	if (event.sessionId !== undefined && event.sessionId.length > NOTE_PROVENANCE_MAX_LENGTH)
		throw new Error(`sessionId cannot exceed ${NOTE_PROVENANCE_MAX_LENGTH} characters`);
	if (event.reason !== undefined && event.reason.length > NOTE_REASON_MAX_CHARACTERS)
		throw new Error(`reason cannot exceed ${NOTE_REASON_MAX_CHARACTERS} characters`);
	return event;
}
