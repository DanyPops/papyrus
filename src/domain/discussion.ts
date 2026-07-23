/**
 * Discuss: a native Papyrus deliberation with a real lifecycle, distinct from a one-shot
 * "ask" (see the design discussion this implements) and from Discourse's forum (kept fully
 * standalone by design -- no dependency here, Discuss reuses none of its storage or wire
 * shape). A Discussion is a `doc` artifact with subtype "discussion": real graph citizenship
 * (edges, show/list) without a fifth enforced artifact kind. Its fine-grained lifecycle
 * lives in extra.discussion rather than the shared doc status vocabulary, since Papyrus
 * enforces status per-kind, not per-subtype -- "deferred" has no equivalent among a plain
 * doc's draft/active/archived. The doc's own status column follows loosely: "active" while
 * extra.discussion.state is active or deferred, "archived" once settled.
 *
 * Blocking is the forcing, load-bearing behavior a Discussion adds over a passive record:
 * an "active" Discussion that `blocks` a Task refuses that Task's completion (see
 * task-service.ts's blockingDiscussions) until the Discussion is settled or deferred.
 * Deferred is explicitly non-blocking -- "we will get back to this," not "resolved".
 */
import {
	DISCUSSION_ACTOR_MAX_LENGTH,
	DISCUSSION_DEFER_REASON_MAX_CHARACTERS,
	DISCUSSION_ROUND_CONTENT_MAX_CHARACTERS,
	DISCUSSION_SETTLEMENT_MAX_CHARACTERS,
} from "../constants.ts";

export const DISCUSSION_SUBTYPE = "discussion";

export const DISCUSSION_STATES = ["active", "deferred", "settled"] as const;
export type DiscussionState = typeof DISCUSSION_STATES[number];

/** Persisted in a discussion Doc's `extra.discussion`. */
export interface DiscussionExtra {
	state: DiscussionState;
	roundCount: number;
	deferredReason?: string;
	settlement?: string;
	settledAt?: string;
}

/** One append-only round of a Discussion -- opening statement is round 1. */
export interface DiscussionRound {
	id: number;
	discussionId: string;
	roundNumber: number;
	actor: string;
	content: string;
	occurredAt: string;
}

export interface AppendDiscussionRound {
	discussionId: string;
	roundNumber: number;
	actor: string;
	content: string;
}

export interface DiscussionRoundQuery {
	discussionId: string;
	afterRound?: number;
	limit?: number;
}

function boundedString(value: string, field: string, maximum: number): string {
	if (value.length === 0 || value.length > maximum) throw new Error(`${field} must be between 1 and ${maximum} characters`);
	return value;
}

export function validateDiscussionContent(content: string): string {
	return boundedString(content, "content", DISCUSSION_ROUND_CONTENT_MAX_CHARACTERS);
}

export function validateDiscussionActor(actor: string): string {
	return boundedString(actor, "actor", DISCUSSION_ACTOR_MAX_LENGTH);
}

export function validateDeferReason(reason: string): string {
	return boundedString(reason, "reason", DISCUSSION_DEFER_REASON_MAX_CHARACTERS);
}

export function validateSettlement(settlement: string): string {
	return boundedString(settlement, "settlement", DISCUSSION_SETTLEMENT_MAX_CHARACTERS);
}

/** True for any artifact (already fetched) that is a Discussion, regardless of its current lifecycle state. */
export function isDiscussionArtifact(artifact: { kind: string; subtype: string }): boolean {
	return artifact.kind === "doc" && artifact.subtype === DISCUSSION_SUBTYPE;
}

/** Reads and defensively validates the extra.discussion shape; throws on a corrupt/foreign shape rather than silently treating it as some default state. */
export function readDiscussionExtra(extra: Record<string, unknown>): DiscussionExtra {
	const raw = extra["discussion"];
	if (typeof raw !== "object" || raw === null) throw new Error("artifact is not a Discussion (missing extra.discussion)");
	const record = raw as Record<string, unknown>;
	const state = record["state"];
	if (typeof state !== "string" || !(DISCUSSION_STATES as readonly string[]).includes(state)) {
		throw new Error(`invalid Discussion state "${String(state)}"`);
	}
	const roundCount = record["roundCount"];
	if (typeof roundCount !== "number" || !Number.isInteger(roundCount) || roundCount < 0) {
		throw new Error("invalid Discussion roundCount");
	}
	return {
		state: state as DiscussionState,
		roundCount,
		...(typeof record["deferredReason"] === "string" ? { deferredReason: record["deferredReason"] } : {}),
		...(typeof record["settlement"] === "string" ? { settlement: record["settlement"] } : {}),
		...(typeof record["settledAt"] === "string" ? { settledAt: record["settledAt"] } : {}),
	};
}
