/**
 * Generic, kind-agnostic mutation event log — the "who did what, when" answer
 * shared by every artifact kind (doc, task, rule, skill), not reinvented per domain.
 *
 * Modeled after scribe's parchment.Event/EventFilter/GetEvents shape, but avoids its
 * known gap: there, the Actor column is defined and filterable yet never populated by
 * any caller. Here, actor/source default to explicit sentinels ("system"/"unknown")
 * rather than being silently blank, and the event is appended by the same choke point
 * that performs the mutation (src/ops.ts), so no domain call site can skip it.
 */
import { ARTIFACT_EVENT_ACTOR_MAX_LENGTH, ARTIFACT_EVENT_HISTORY_DEFAULT_LIMIT, ARTIFACT_EVENT_HISTORY_MAX_LIMIT } from "../constants.ts";

export const ARTIFACT_EVENT_TYPES = ["created", "updated", "status_changed", "extra_set", "linked", "unlinked", "trashed", "restored"] as const;
export type ArtifactEventType = typeof ARTIFACT_EVENT_TYPES[number];
export type ArtifactEventDirection = "asc" | "desc";

/** Caller-supplied identity for a mutation. All fields are advisory (self-reported), not cryptographically verified. */
export interface ArtifactEventContext {
	actor?: string;
	source?: string;
	sessionId?: string;
}

export interface ArtifactEvent {
	id: number;
	artifactId: string;
	occurredAt: string;
	type: ArtifactEventType;
	actor: string;
	source: string;
	sessionId?: string;
	fromStatus?: string;
	toStatus?: string;
	relation?: string;
	relatedId?: string;
	schemaVersion: 1;
}

export interface AppendArtifactEvent {
	artifactId: string;
	type: ArtifactEventType;
	actor?: string;
	source?: string;
	sessionId?: string;
	fromStatus?: string;
	toStatus?: string;
	relation?: string;
	relatedId?: string;
}

export interface ArtifactEventQuery {
	artifactId?: string;
	actor?: string;
	sessionId?: string;
	since?: string;
	limit?: number;
	cursor?: number;
	direction?: ArtifactEventDirection;
}

export interface ArtifactEventPage {
	events: ArtifactEvent[];
	nextCursor?: number;
}

/** No caller-supplied identity defaults to these explicit sentinels — never a silent blank. */
export const ARTIFACT_EVENT_DEFAULT_ACTOR = "system";
export const ARTIFACT_EVENT_DEFAULT_SOURCE = "unknown";

function boundedString(value: string, field: string, maximum: number): string {
	if (value.length === 0 || value.length > maximum) throw new Error(`${field} must be between 1 and ${maximum} characters`);
	return value;
}

/** Fills defaults and enforces bounds. The one place every appended event is normalized. */
export function resolveArtifactEvent(input: AppendArtifactEvent): Required<Pick<AppendArtifactEvent, "actor" | "source">> & AppendArtifactEvent {
	if (!input.artifactId) throw new Error("artifactId is required");
	const actor = boundedString(input.actor ?? ARTIFACT_EVENT_DEFAULT_ACTOR, "actor", ARTIFACT_EVENT_ACTOR_MAX_LENGTH);
	const source = boundedString(input.source ?? ARTIFACT_EVENT_DEFAULT_SOURCE, "source", ARTIFACT_EVENT_ACTOR_MAX_LENGTH);
	if (input.sessionId !== undefined) boundedString(input.sessionId, "sessionId", ARTIFACT_EVENT_ACTOR_MAX_LENGTH);
	return { ...input, actor, source };
}

export function normalizeArtifactEventQuery(query: ArtifactEventQuery): Required<Pick<ArtifactEventQuery, "limit" | "direction">> & ArtifactEventQuery {
	if (!query.artifactId && !query.actor && !query.sessionId) {
		throw new Error("artifact event query requires artifactId, actor, or sessionId to stay bounded");
	}
	const limit = query.limit ?? ARTIFACT_EVENT_HISTORY_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_EVENT_HISTORY_MAX_LIMIT) {
		throw new Error(`artifact event limit must be between 1 and ${ARTIFACT_EVENT_HISTORY_MAX_LIMIT}`);
	}
	if (query.cursor !== undefined && (!Number.isInteger(query.cursor) || query.cursor < 1)) {
		throw new Error("artifact event cursor must be a positive integer");
	}
	if (query.direction !== undefined && query.direction !== "asc" && query.direction !== "desc") {
		throw new Error("artifact event direction must be asc or desc");
	}
	return { ...query, limit, direction: query.direction ?? "desc" };
}
