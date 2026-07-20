import {
	NOTE_BODY_MAX_CHARACTERS,
	NOTE_HISTORY_MAX_EVENTS,
	NOTE_LIST_DEFAULT_LIMIT,
	NOTE_LIST_MAX_LIMIT,
	NOTE_PROVENANCE_MAX_LENGTH,
	NOTE_REASON_MAX_CHARACTERS,
	NOTE_TITLE_MAX_CHARACTERS,
	TASK_PROJECT_ROOT_MAX_LENGTH,
} from "./constants.ts";
import type { Artifact } from "./domain/artifact.ts";
import { requireAtomicArtifactStore } from "./ports/atomic-artifact-store.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";

export const NOTE_SUBTYPE = "note";
export const NOTE_DISPOSITIONS = ["completed", "duplicate", "declined", "superseded"] as const;
export type NoteDisposition = typeof NOTE_DISPOSITIONS[number];

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

export interface ArchiveNoteInput extends NoteProvenance {
	projectRoot: string;
	disposition: NoteDisposition;
}

interface NoteHistoryEvent {
	action: "captured" | "consumed" | "promoted" | "archived";
	at: string;
	actor: string;
	source: string;
	sessionId?: string;
	reason?: string;
	targetId?: string;
	disposition?: NoteDisposition | "promoted";
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

function noteTitle(body: string, requested?: string): string {
	if (requested !== undefined) return requiredBounded(requested, "note title", NOTE_TITLE_MAX_CHARACTERS);
	const firstLine = body.split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ").trim();
	return firstLine.slice(0, NOTE_TITLE_MAX_CHARACTERS) || "Deferred note";
}

function provenance(input: NoteProvenance, defaults: { actor: string; source: string }): Omit<NoteHistoryEvent, "action" | "at"> {
	return {
		actor: optionalBounded(input.actor, "note actor", NOTE_PROVENANCE_MAX_LENGTH) ?? defaults.actor,
		source: optionalBounded(input.source, "note source", NOTE_PROVENANCE_MAX_LENGTH) ?? defaults.source,
		...(input.sessionId ? { sessionId: requiredBounded(input.sessionId, "note session id", NOTE_PROVENANCE_MAX_LENGTH) } : {}),
		...(input.reason ? { reason: requiredBounded(input.reason, "note reason", NOTE_REASON_MAX_CHARACTERS) } : {}),
	};
}

function history(artifact: Artifact): NoteHistoryEvent[] {
	const value = artifact.extra["noteHistory"];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is NoteHistoryEvent => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function appendHistory(artifact: Artifact, event: NoteHistoryEvent): Record<string, unknown> {
	return {
		...artifact.extra,
		noteHistory: [...history(artifact), event].slice(-NOTE_HISTORY_MAX_EVENTS),
	};
}

function event(action: NoteHistoryEvent["action"], input: NoteProvenance, extra: Partial<NoteHistoryEvent> = {}): NoteHistoryEvent {
	return {
		action,
		at: new Date().toISOString(),
		...provenance(input, { actor: action === "captured" ? "human" : "agent", source: "notes" }),
		...extra,
	};
}

export class Notes {
	constructor(private readonly artifacts: ArtifactStore) {}

	capture(input: CaptureNoteInput): Artifact {
		const projectRoot = requiredBounded(input.projectRoot, "project_root", TASK_PROJECT_ROOT_MAX_LENGTH);
		const body = requiredBounded(input.body, "note body", NOTE_BODY_MAX_CHARACTERS);
		const captured = event("captured", input);
		return this.artifacts.create({
			kind: "doc",
			subtype: NOTE_SUBTYPE,
			status: "draft",
			title: noteTitle(body, input.title),
			body,
			labels: ["note", "inbox"],
			extra: { projectRoot, noteHistory: [captured] },
		});
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

	show(id: string, projectRoot: string): Artifact {
		const note = this.requireNote(id);
		this.requireProject(note, projectRoot);
		return this.artifacts.get(id, { tree: true })!;
	}

	consume(id: string, input: NoteProvenance & { projectRoot: string }): Artifact {
		const atomic = requireAtomicArtifactStore(this.artifacts);
		return atomic.atomic(() => {
			const note = this.requireNote(id);
			this.requireProject(note, input.projectRoot);
			if (note.status === "archived") throw new Error("cannot consume an archived note");
			if (note.status === "active") return this.artifacts.get(id, { tree: true })!;
			this.artifacts.setExtra(id, appendHistory(note, event("consumed", input)));
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
			const promoted = event("promoted", input, { disposition: "promoted", targetId });
			const disposition = { kind: "promoted", targetId, ...(promoted.reason ? { reason: promoted.reason } : {}) };
			this.artifacts.link({ from: id, relation: "relates_to", to: targetId });
			this.artifacts.setExtra(id, {
				...appendHistory(note, promoted),
				disposition,
			});
			this.artifacts.setStatus(id, "archived");
			return this.artifacts.get(id, { tree: true })!;
		});
	}

	archive(id: string, input: ArchiveNoteInput): Artifact {
		if (!NOTE_DISPOSITIONS.includes(input.disposition)) throw new Error("note disposition must be completed, duplicate, declined, or superseded");
		const atomic = requireAtomicArtifactStore(this.artifacts);
		return atomic.atomic(() => {
			const note = this.requireNote(id);
			this.requireProject(note, input.projectRoot);
			if (note.status === "archived") throw new Error("note is already archived");
			const archived = event("archived", input, { disposition: input.disposition });
			const details = { kind: input.disposition, ...(archived.reason ? { reason: archived.reason } : {}) };
			this.artifacts.setExtra(id, {
				...appendHistory(note, archived),
				disposition: details,
			});
			this.artifacts.setStatus(id, "archived");
			return this.artifacts.get(id, { tree: true })!;
		});
	}

	private requireNote(id: string): Artifact {
		const artifact = this.artifacts.get(id);
		if (!artifact || artifact.kind !== "doc" || artifact.subtype !== NOTE_SUBTYPE) throw new Error(`note "${id}" not found`);
		return artifact;
	}

	private requireProject(note: Artifact, projectRoot: string): void {
		const requested = requiredBounded(projectRoot, "project_root", TASK_PROJECT_ROOT_MAX_LENGTH);
		if (note.extra["projectRoot"] !== requested) throw new Error(`note "${note.id}" is outside project scope`);
	}
}
