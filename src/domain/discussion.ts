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
	DISCUSSION_OPTION_MAX_LENGTH,
	DISCUSSION_OPTIONS_MAX_COUNT,
	DISCUSSION_OPTIONS_MIN_COUNT,
	DISCUSSION_ROUND_CONTENT_MAX_CHARACTERS,
	DISCUSSION_SETTLEMENT_MAX_CHARACTERS,
} from "../constants.ts";

export const DISCUSSION_SUBTYPE = "discussion";

export const DISCUSSION_STATES = ["active", "deferred", "settled"] as const;
export type DiscussionState = typeof DISCUSSION_STATES[number];

/**
 * A round can pose a choice (options + optionsMode) the way opencode's QuestionV2 poses
 * labeled multiple-choice options, or answer one (selected). "single" is mutually exclusive
 * (exactly one pick); "multi" allows several -- see constants.ts.
 */
export const DISCUSSION_OPTIONS_MODES = ["single", "multi"] as const;
export type DiscussionOptionsMode = typeof DISCUSSION_OPTIONS_MODES[number];

/** Persisted in a discussion Doc's `extra.discussion`. pendingOptions/-Mode is the current-state cache of "is there an unanswered posed choice right now" -- cleared once answered, set again whenever a round poses a new one. */
export interface DiscussionExtra {
	state: DiscussionState;
	roundCount: number;
	deferredReason?: string;
	settlement?: string;
	settledAt?: string;
	pendingOptions?: string[];
	pendingOptionsMode?: DiscussionOptionsMode;
}

/** One append-only round of a Discussion -- opening statement is round 1. options/optionsMode/selected are the historical record of what was posed/picked in this specific round (extra.discussion.pendingOptions is the separate, mutable "what's unanswered right now" cache). */
export interface DiscussionRound {
	id: number;
	discussionId: string;
	roundNumber: number;
	actor: string;
	content: string;
	occurredAt: string;
	options?: string[];
	optionsMode?: DiscussionOptionsMode;
	selected?: string[];
}

export interface AppendDiscussionRound {
	discussionId: string;
	roundNumber: number;
	actor: string;
	content: string;
	options?: string[];
	optionsMode?: DiscussionOptionsMode;
	selected?: string[];
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

/** Validates a freshly-posed choice: 2..DISCUSSION_OPTIONS_MAX_COUNT unique, bounded-length options and a real mode. */
export function validateDiscussionOptions(options: string[], mode: string): { options: string[]; mode: DiscussionOptionsMode } {
	if (!(DISCUSSION_OPTIONS_MODES as readonly string[]).includes(mode)) {
		throw new Error(`options_mode must be one of ${DISCUSSION_OPTIONS_MODES.join(", ")}`);
	}
	if (options.length < DISCUSSION_OPTIONS_MIN_COUNT || options.length > DISCUSSION_OPTIONS_MAX_COUNT) {
		throw new Error(`options must have between ${DISCUSSION_OPTIONS_MIN_COUNT} and ${DISCUSSION_OPTIONS_MAX_COUNT} entries`);
	}
	for (const option of options) boundedString(option, "option", DISCUSSION_OPTION_MAX_LENGTH);
	if (new Set(options).size !== options.length) throw new Error("options must not repeat an entry");
	return { options: [...options], mode: mode as DiscussionOptionsMode };
}

/** Validates an answer against the Discussion's currently pending posed choice, if any. */
export function validateSelectedOptions(selected: string[], pendingOptions: string[] | undefined, pendingMode: DiscussionOptionsMode | undefined): string[] {
	if (!pendingOptions || pendingOptions.length === 0 || !pendingMode) {
		throw new Error("this Discussion has no pending options to select from");
	}
	if (selected.length === 0) throw new Error("selected must not be empty");
	if (new Set(selected).size !== selected.length) throw new Error("selected must not repeat an option");
	const unknown = selected.filter((entry) => !pendingOptions.includes(entry));
	if (unknown.length > 0) throw new Error(`selected option(s) not offered: ${unknown.join(", ")}`);
	if (pendingMode === "single" && selected.length > 1) throw new Error('this Discussion\'s pending options are "single": pick exactly one');
	return [...selected];
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
	const pendingOptions = record["pendingOptions"];
	if (pendingOptions !== undefined && (!Array.isArray(pendingOptions) || pendingOptions.some((entry) => typeof entry !== "string"))) {
		throw new Error("invalid Discussion pendingOptions");
	}
	const pendingOptionsMode = record["pendingOptionsMode"];
	if (pendingOptionsMode !== undefined && !(DISCUSSION_OPTIONS_MODES as readonly unknown[]).includes(pendingOptionsMode)) {
		throw new Error("invalid Discussion pendingOptionsMode");
	}
	return {
		state: state as DiscussionState,
		roundCount,
		...(typeof record["deferredReason"] === "string" ? { deferredReason: record["deferredReason"] } : {}),
		...(typeof record["settlement"] === "string" ? { settlement: record["settlement"] } : {}),
		...(typeof record["settledAt"] === "string" ? { settledAt: record["settledAt"] } : {}),
		...(pendingOptions !== undefined ? { pendingOptions: pendingOptions as string[] } : {}),
		...(pendingOptionsMode !== undefined ? { pendingOptionsMode: pendingOptionsMode as DiscussionOptionsMode } : {}),
	};
}
