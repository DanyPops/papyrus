import { createHash } from "node:crypto";
import type { Artifact } from "../artifact/artifact.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { requireAtomicArtifactStore } from "../artifact/atomic-artifact-store.ts";
import {
	NOTE_BODY_MAX_CHARACTERS,
	NOTE_LIST_DEFAULT_LIMIT,
	NOTE_LIST_MAX_LIMIT,
	NOTE_PROVENANCE_MAX_LENGTH,
	NOTE_REASON_MAX_CHARACTERS,
	NOTE_TITLE_MAX_CHARACTERS,
	TASK_PROJECT_ROOT_MAX_LENGTH,
} from "../constants.ts";
import type { AppendNoteEvent, NoteEventType, NoteHistoryPage, NoteHistoryQuery } from "./note-event.ts";
import { InMemoryNoteEventStore, type NoteEventStore } from "./note-event-store.ts";

export const NOTE_SUBTYPE = "note";
export const NOTE_DISPOSITIONS = ["completed", "duplicate", "declined", "superseded"] as const;
export type NoteDisposition = (typeof NOTE_DISPOSITIONS)[number];

export interface NoteProvenance {
	actor?: string;
	source?: string;
	sessionId?: string;
	reason?: string;
}

export interface CaptureNoteInput extends NoteProvenance {
	body: string;
	title?: string;
	projectRoot: string;
}

export interface ListNotesInput {
	projectRoot: string;
	status?: "draft" | "active" | "archived";
	text?: string;
	limit?: number;
}

export interface ListNotesPageInput {
	/** Omit only for an explicit cross-project inventory. */
	projectRoot?: string;
	status?: "draft" | "active" | "archived";
	text?: string;
	limit?: number;
	cursor?: string;
}

export interface NotesPage {
	items: Artifact[];
	nextCursor?: string;
}

interface NotesPageCursor {
	v: 1;
	createdAt: string;
	id: string;
	filterHash: string;
}

export interface ArchiveNoteInput extends NoteProvenance {
	projectRoot: string;
	disposition: NoteDisposition;
}

function requiredBounded(value: string, field: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} is required`);
	if (normalized.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
	return normalized;
}

function optionalBounded(value: string | undefined, field: string, maximum: number): string | undefined {
	if (value === undefined) return undefined;
	return requiredBounded(value, field, maximum);
}

function notesPageFilterHash(input: ListNotesPageInput, projectRoot: string | undefined): string {
	return createHash("sha256")
		.update(JSON.stringify({ projectRoot, status: input.status, text: input.text }))
		.digest("base64url");
}

function decodeNotesPageCursor(cursor: string | undefined, filterHash: string): NotesPageCursor | undefined {
	if (cursor === undefined) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<NotesPageCursor>;
		if (parsed.v !== 1 || !parsed.createdAt || !parsed.id || parsed.filterHash !== filterHash) throw new Error("invalid cursor");
		return parsed as NotesPageCursor;
	} catch {
		throw new Error("notes page cursor is invalid or does not match the requested filters");
	}
}

function encodeNotesPageCursor(note: Artifact, filterHash: string): string {
	return Buffer.from(JSON.stringify({ v: 1, createdAt: note.created_at, id: note.id, filterHash } satisfies NotesPageCursor)).toString(
		"base64url",
	);
}

function noteTitle(body: string, requested?: string): string {
	if (requested !== undefined) return requiredBounded(requested, "note title", NOTE_TITLE_MAX_CHARACTERS);
	const firstLine = body.split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ").trim();
	return firstLine.slice(0, NOTE_TITLE_MAX_CHARACTERS) || "Deferred note";
}

function provenance(
	input: NoteProvenance,
	defaults: { actor: string; source: string },
): Omit<AppendNoteEvent, "noteId" | "type" | "relatedId" | "disposition"> {
	return {
		actor: optionalBounded(input.actor, "note actor", NOTE_PROVENANCE_MAX_LENGTH) ?? defaults.actor,
		source: optionalBounded(input.source, "note source", NOTE_PROVENANCE_MAX_LENGTH) ?? defaults.source,
		...(input.sessionId ? { sessionId: requiredBounded(input.sessionId, "note session id", NOTE_PROVENANCE_MAX_LENGTH) } : {}),
		...(input.reason ? { reason: requiredBounded(input.reason, "note reason", NOTE_REASON_MAX_CHARACTERS) } : {}),
	};
}

export class Notes {
	constructor(
		private readonly artifacts: ArtifactStore,
		private readonly events: NoteEventStore = new InMemoryNoteEventStore(),
	) {}

	capture(input: CaptureNoteInput): Artifact {
		const projectRoot = requiredBounded(input.projectRoot, "project_root", TASK_PROJECT_ROOT_MAX_LENGTH);
		const body = requiredBounded(input.body, "note body", NOTE_BODY_MAX_CHARACTERS);
		const created = this.artifacts.create({
			kind: "doc",
			subtype: NOTE_SUBTYPE,
			status: "draft",
			title: noteTitle(body, input.title),
			body,
			labels: ["note", "inbox"],
			extra: { projectRoot },
		});
		this.appendEvent(created.id, "captured", input, { actor: "human", source: "notes" });
		return created;
	}

	list(input: ListNotesInput): Artifact[] {
		const projectRoot = requiredBounded(input.projectRoot, "project_root", TASK_PROJECT_ROOT_MAX_LENGTH);
		const limit = input.limit ?? NOTE_LIST_DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit < 1 || limit > NOTE_LIST_MAX_LIMIT) {
			throw new Error(`note limit must be an integer from 1 to ${NOTE_LIST_MAX_LIMIT}`);
		}
		return this.artifacts.query({
			kind: "doc",
			subtype: NOTE_SUBTYPE,
			...(input.status ? { status: input.status } : { statuses: ["draft", "active"] }),
			...(input.text ? { text: input.text } : {}),
			extraEquals: { projectRoot },
			limit,
		});
	}

	/** Cursor-paged inventory; omitting projectRoot intentionally enumerates notes across projects. */
	listPage(input: ListNotesPageInput): NotesPage {
		const projectRoot =
			input.projectRoot === undefined ? undefined : requiredBounded(input.projectRoot, "project_root", TASK_PROJECT_ROOT_MAX_LENGTH);
		const limit = input.limit ?? NOTE_LIST_DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit < 1 || limit > NOTE_LIST_MAX_LIMIT) {
			throw new Error(`note limit must be an integer from 1 to ${NOTE_LIST_MAX_LIMIT}`);
		}
		const filterHash = notesPageFilterHash(input, projectRoot);
		const cursor = decodeNotesPageCursor(input.cursor, filterHash);
		const candidates = this.artifacts.query({
			kind: "doc",
			subtype: NOTE_SUBTYPE,
			...(input.status ? { status: input.status } : { statuses: ["draft", "active"] }),
			...(input.text ? { text: input.text } : {}),
			...(projectRoot ? { extraEquals: { projectRoot } } : {}),
			order: "created_desc",
			...(cursor ? { after: { createdAt: cursor.createdAt, id: cursor.id } } : {}),
			limit: limit + 1,
		});
		const items = candidates.slice(0, limit);
		return {
			items,
			...(candidates.length > limit && items.length > 0 ? { nextCursor: encodeNotesPageCursor(items.at(-1)!, filterHash) } : {}),
		};
	}

	show(id: string, projectRoot: string): Artifact {
		const note = this.requireNote(id);
		this.requireProject(note, projectRoot);
		return this.artifacts.get(id, { tree: true })!;
	}

	/** Real append-only event history for this note -- see domain/note-event.ts. */
	history(id: string, projectRoot: string, query?: NoteHistoryQuery): NoteHistoryPage {
		const note = this.requireNote(id);
		this.requireProject(note, projectRoot);
		return this.events.history(id, query);
	}

	consume(id: string, input: NoteProvenance & { projectRoot: string }): Artifact {
		const atomic = requireAtomicArtifactStore(this.artifacts);
		return atomic.atomic(() => {
			const note = this.requireNote(id);
			this.requireProject(note, input.projectRoot);
			if (note.status === "archived") throw new Error("cannot consume an archived note");
			if (note.status === "active") return this.artifacts.get(id, { tree: true })!;
			this.appendEvent(id, "consumed", input, { actor: "agent", source: "notes" });
			this.artifacts.setStatus(id, "active");
			return this.artifacts.get(id, { tree: true })!;
		});
	}

	promote(id: string, targetId: string, input: NoteProvenance & { projectRoot: string }): Artifact {
		const atomic = requireAtomicArtifactStore(this.artifacts);
		return atomic.atomic(() => {
			const note = this.requireNote(id);
			this.requireProject(note, input.projectRoot);
			if (note.status === "archived") throw new Error("cannot promote an archived note");
			if (targetId === id) throw new Error("a note cannot promote to itself");
			if (!this.artifacts.get(targetId)) throw new Error(`promotion target "${targetId}" not found`);
			const reason = optionalBounded(input.reason, "note reason", NOTE_REASON_MAX_CHARACTERS);
			this.artifacts.link({ from: id, relation: "relates_to", to: targetId });
			this.appendEvent(id, "promoted", input, { actor: "agent", source: "notes" }, { relatedId: targetId, disposition: "promoted" });
			this.artifacts.setExtra(id, {
				...note.extra,
				disposition: { kind: "promoted", targetId, ...(reason ? { reason } : {}) },
			});
			this.artifacts.setStatus(id, "archived");
			return this.artifacts.get(id, { tree: true })!;
		});
	}

	archive(id: string, input: ArchiveNoteInput): Artifact {
		if (!NOTE_DISPOSITIONS.includes(input.disposition))
			throw new Error("note disposition must be completed, duplicate, declined, or superseded");
		const atomic = requireAtomicArtifactStore(this.artifacts);
		return atomic.atomic(() => {
			const note = this.requireNote(id);
			this.requireProject(note, input.projectRoot);
			if (note.status === "archived") throw new Error("note is already archived");
			const reason = optionalBounded(input.reason, "note reason", NOTE_REASON_MAX_CHARACTERS);
			this.appendEvent(id, "archived", input, { actor: "agent", source: "notes" }, { disposition: input.disposition });
			this.artifacts.setExtra(id, {
				...note.extra,
				disposition: { kind: input.disposition, ...(reason ? { reason } : {}) },
			});
			this.artifacts.setStatus(id, "archived");
			return this.artifacts.get(id, { tree: true })!;
		});
	}

	private appendEvent(
		noteId: string,
		type: NoteEventType,
		input: NoteProvenance,
		defaults: { actor: string; source: string },
		extra: Partial<Pick<AppendNoteEvent, "relatedId" | "disposition">> = {},
	): void {
		this.events.append({ noteId, type, ...provenance(input, defaults), ...extra });
	}

	private requireNote(id: string): Artifact {
		const artifact = this.artifacts.get(id);
		if (artifact?.kind !== "doc" || artifact.subtype !== NOTE_SUBTYPE) throw new Error(`note "${id}" not found`);
		return artifact;
	}

	private requireProject(note: Artifact, projectRoot: string): void {
		const requested = requiredBounded(projectRoot, "project_root", TASK_PROJECT_ROOT_MAX_LENGTH);
		if (note.extra.projectRoot !== requested) throw new Error(`note "${note.id}" is outside project scope`);
	}
}
