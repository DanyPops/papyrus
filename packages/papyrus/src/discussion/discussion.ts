/**
 * Discuss: a native Papyrus deliberation with a real lifecycle, distinct from a one-shot
 * "ask" (see the design discussion this implements) and from Discourse's forum (kept fully
 * standalone by design -- no dependency here, Discuss reuses none of its storage or wire
 * shape). A Discussion is a `task` artifact with subtype "discussion": not a passive
 * record (see the blocking behavior below), so it takes the kind whose lifecycle, focus,
 * and dependency-graph machinery are already built for unresolved work -- not a fifth
 * enforced artifact kind. Its fine-grained lifecycle lives in
 * extra.discussion rather than the shared task status vocabulary, since Papyrus enforces
 * status per-kind, not per-subtype -- "deferred" has no equivalent among a plain task's
 * todo/in-progress/review/done/rejected/canceled. The task's own status column follows
 * loosely: "in-progress" while extra.discussion.state is active or deferred, "done" once
 * settled.
 *
 * Blocking is the forcing, load-bearing behavior a Discussion adds over a passive record:
 * an "active" Discussion that `blocks` a Task refuses that Task's completion (see
 * task-service.ts's blockingDiscussions) until the Discussion is settled or deferred.
 * Deferred is explicitly non-blocking -- "we will get back to this," not "resolved".
 */
import {
	DISCUSSION_ACTOR_MAX_LENGTH,
	DISCUSSION_DEFER_REASON_MAX_CHARACTERS,
	DISCUSSION_OPTION_DESCRIPTION_MAX_LENGTH,
	DISCUSSION_OPTION_DESCRIPTION_REQUIRED_FROM_COUNT,
	DISCUSSION_OPTION_MAX_LENGTH,
	DISCUSSION_OPTIONS_MAX_COUNT,
	DISCUSSION_OPTIONS_MIN_COUNT,
	DISCUSSION_QUIZ_EXPLANATION_MAX_CHARACTERS,
	DISCUSSION_QUIZ_OPTION_LABEL_MAX_COUNT,
	DISCUSSION_ROUND_CONTENT_MAX_CHARACTERS,
	DISCUSSION_SETTLEMENT_MAX_CHARACTERS,
} from "../constants.ts";

export const DISCUSSION_SUBTYPE = "discussion";

export const DISCUSSION_STATES = ["active", "deferred", "settled"] as const;
export type DiscussionState = (typeof DISCUSSION_STATES)[number];

/**
 * A round can pose a choice (options + optionsMode) the way opencode's QuestionV2 poses
 * labeled multiple-choice options, or answer one (selected). "single" is mutually exclusive
 * (exactly one pick); "multi" allows several -- see constants.ts.
 */
export const DISCUSSION_OPTIONS_MODES = ["single", "multi"] as const;
export type DiscussionOptionsMode = (typeof DISCUSSION_OPTIONS_MODES)[number];

/** Persisted in a discussion Doc's `extra.discussion`. pendingOptions/-Mode is the current-state cache of "is there an unanswered posed choice right now" -- cleared once answered, set again whenever a round poses a new one. */
export interface DiscussionExtra {
	state: DiscussionState;
	roundCount: number;
	deferredReason?: string;
	settlement?: string;
	settledAt?: string;
	pendingOptions?: string[];
	pendingOptionsMode?: DiscussionOptionsMode;
	/** Index-aligned with pendingOptions when present -- one entry per option, empty string meaning
	 * "no description for this one". Purely descriptive metadata: selection/validation only ever
	 * matches against pendingOptions itself, never against this array. */
	pendingOptionDescriptions?: string[];
	/** True when the currently pending posed choice is a graded quiz -- safe to expose (announces
	 * "this will be graded", never the answer itself, which never lives in extra.discussion at all;
	 * see AppendDiscussionRound's own comment for where the real answer is kept instead). */
	pendingIsQuiz?: boolean;
	/** The round number that posed the currently pending quiz -- lets reply() look up its hidden
	 * answer in O(1) via DiscussionRoundStore.resolvePendingQuizAnswer, without scanning history. */
	pendingQuizRoundNumber?: number;
}

/**
 * One append-only round of a Discussion -- opening statement is round 1. options/optionsMode/selected
 * are the historical record of what was posed/picked in this specific round (extra.discussion.pendingOptions
 * is the separate, mutable "what's unanswered right now" cache).
 *
 * quiz/quizResult are the two quiz-safe fields: `quiz: true` marks a posing round as graded (never
 * the correct answer itself -- that never appears on this type, by construction, see
 * AppendDiscussionRound); `quizResult` appears only on the round that actually answered a pending
 * quiz, once grading has already happened -- safe to reveal at that point since submission is done.
 */
export interface DiscussionRound {
	id: number;
	discussionId: string;
	roundNumber: number;
	actor: string;
	content: string;
	occurredAt: string;
	options?: string[];
	optionsMode?: DiscussionOptionsMode;
	/** Index-aligned with options -- see DiscussionExtra.pendingOptionDescriptions. */
	optionDescriptions?: string[];
	selected?: string[];
	/** True when this round posed a graded quiz alongside options/optionsMode. */
	quiz?: boolean;
	/** Present only on the round that answered a pending quiz -- the graded outcome, safe to show
	 * because the participant has already submitted by the time this exists. */
	quizResult?: DiscussionQuizResult;
}

/** The graded outcome of one quiz submission, attached to the answering round. */
export interface DiscussionQuizResult {
	correct: boolean;
	/** The full correct set, drawn verbatim from the options that were offered. */
	correctOptions: string[];
	explanation: string;
}

export interface AppendDiscussionRound {
	discussionId: string;
	roundNumber: number;
	actor: string;
	content: string;
	options?: string[];
	optionsMode?: DiscussionOptionsMode;
	optionDescriptions?: string[];
	selected?: string[];
	/** Marks this round as posing a graded quiz -- paired with quizCorrectOptions/quizExplanation below. */
	quiz?: boolean;
	/**
	 * Write-only: the quiz's actual answer, persisted for grading but deliberately absent from
	 * DiscussionRound (the read-side type) -- a store implementation must never select these columns
	 * into anything it returns from list()/append()'s own return value. Only
	 * DiscussionRoundStore.resolvePendingQuizAnswer may ever read them back, from within the same
	 * reply() transaction that performs grading.
	 */
	quizCorrectOptions?: string[];
	quizExplanation?: string;
	/** The already-graded outcome to persist on an answering round -- computed by discussion-service.ts
	 * before this reaches the store, never derived by the store itself. */
	quizResult?: DiscussionQuizResult;
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

/** Validates a freshly-posed choice: 2..DISCUSSION_OPTIONS_MAX_COUNT unique, bounded-length
 * options, a real mode, and a non-empty description for every option once
 * DISCUSSION_OPTION_DESCRIPTION_REQUIRED_FROM_COUNT or more are posed. */
export function validateDiscussionOptions(
	options: string[],
	mode: string,
	optionDescriptions?: string[],
): { options: string[]; mode: DiscussionOptionsMode; optionDescriptions?: string[] } {
	if (!(DISCUSSION_OPTIONS_MODES as readonly string[]).includes(mode)) {
		throw new Error(`options_mode must be one of ${DISCUSSION_OPTIONS_MODES.join(", ")}`);
	}
	if (options.length < DISCUSSION_OPTIONS_MIN_COUNT || options.length > DISCUSSION_OPTIONS_MAX_COUNT) {
		throw new Error(`options must have between ${DISCUSSION_OPTIONS_MIN_COUNT} and ${DISCUSSION_OPTIONS_MAX_COUNT} entries`);
	}
	for (const option of options) boundedString(option, "option", DISCUSSION_OPTION_MAX_LENGTH);
	if (new Set(options).size !== options.length) throw new Error("options must not repeat an entry");
	const descriptionsRequired = options.length >= DISCUSSION_OPTION_DESCRIPTION_REQUIRED_FROM_COUNT;
	if (
		descriptionsRequired &&
		(optionDescriptions === undefined || optionDescriptions.some((description) => description.trim().length === 0))
	) {
		throw new Error(
			`option_descriptions is required, with a non-empty entry for every option, once ${DISCUSSION_OPTION_DESCRIPTION_REQUIRED_FROM_COUNT} or more options are posed`,
		);
	}
	if (optionDescriptions !== undefined) {
		if (optionDescriptions.length !== options.length)
			throw new Error("option_descriptions must have exactly one entry per option (use an empty string for none)");
		for (const description of optionDescriptions) {
			if (description.length > DISCUSSION_OPTION_DESCRIPTION_MAX_LENGTH)
				throw new Error(`option description must be at most ${DISCUSSION_OPTION_DESCRIPTION_MAX_LENGTH} characters`);
		}
	}
	return {
		options: [...options],
		mode: mode as DiscussionOptionsMode,
		...(optionDescriptions !== undefined ? { optionDescriptions: [...optionDescriptions] } : {}),
	};
}

/**
 * Validates a quiz's correct-answer + explanation against the options it's layered onto (already
 * validated by validateDiscussionOptions). correctOptions is one or more entries drawn verbatim
 * from options -- exact text match, the same identity scheme `selected` uses. A "single" quiz
 * (the participant can only pick one) must have exactly one correct option; a "multi" quiz may
 * have several. explanation is mandatory -- always shown after grading, never optional.
 */
export function validateDiscussionQuiz(
	options: string[],
	mode: DiscussionOptionsMode,
	correctOptions: string[],
	explanation: string,
): { correctOptions: string[]; explanation: string } {
	if (correctOptions.length === 0) throw new Error("quiz correct_options must not be empty");
	if (new Set(correctOptions).size !== correctOptions.length) throw new Error("quiz correct_options must not repeat an entry");
	const unknown = correctOptions.filter((entry) => !options.includes(entry));
	if (unknown.length > 0) throw new Error(`quiz correct_options must be among the offered options: ${unknown.join(", ")}`);
	if (mode === "single" && correctOptions.length !== 1) {
		throw new Error('a "single" quiz must have exactly one correct_option');
	}
	const validExplanation = boundedString(explanation, "explanation", DISCUSSION_QUIZ_EXPLANATION_MAX_CHARACTERS);
	return { correctOptions: [...correctOptions], explanation: validExplanation };
}

/** Correct iff the participant's selection exactly matches the quiz's correct set -- no partial credit. */
export function gradeQuizAnswer(selected: string[], correctOptions: string[]): boolean {
	return selected.length === correctOptions.length && selected.every((entry) => correctOptions.includes(entry));
}

/**
 * Display-only label for a quiz option by its position (A, B, C, ...) -- never persisted, never
 * part of a quiz's addressing scheme (options/correct_options/selected all match by exact text).
 * Single letters only: see DISCUSSION_QUIZ_OPTION_LABEL_MAX_COUNT's own comment for why that's
 * always enough given the enforced DISCUSSION_OPTIONS_MAX_COUNT.
 */
export function quizOptionLabel(index: number): string {
	if (index < 0 || index >= DISCUSSION_QUIZ_OPTION_LABEL_MAX_COUNT) {
		throw new Error(`quiz option index ${index} has no single-letter label (max ${DISCUSSION_QUIZ_OPTION_LABEL_MAX_COUNT} options)`);
	}
	return String.fromCharCode(65 + index);
}

export function validateSelectedOptions(
	selected: string[],
	pendingOptions: string[] | undefined,
	pendingMode: DiscussionOptionsMode | undefined,
): string[] {
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
	return artifact.kind === "task" && artifact.subtype === DISCUSSION_SUBTYPE;
}

/** Reads and defensively validates the extra.discussion shape; throws on a corrupt/foreign shape rather than silently treating it as some default state. */
export function readDiscussionExtra(extra: Record<string, unknown>): DiscussionExtra {
	const raw = extra.discussion;
	if (typeof raw !== "object" || raw === null) throw new Error("artifact is not a Discussion (missing extra.discussion)");
	const record = raw as Record<string, unknown>;
	const state = record.state;
	if (typeof state !== "string" || !(DISCUSSION_STATES as readonly string[]).includes(state)) {
		throw new Error(`invalid Discussion state "${String(state)}"`);
	}
	const roundCount = record.roundCount;
	if (typeof roundCount !== "number" || !Number.isInteger(roundCount) || roundCount < 0) {
		throw new Error("invalid Discussion roundCount");
	}
	const pendingOptions = record.pendingOptions;
	if (pendingOptions !== undefined && (!Array.isArray(pendingOptions) || pendingOptions.some((entry) => typeof entry !== "string"))) {
		throw new Error("invalid Discussion pendingOptions");
	}
	const pendingOptionsMode = record.pendingOptionsMode;
	if (pendingOptionsMode !== undefined && !(DISCUSSION_OPTIONS_MODES as readonly unknown[]).includes(pendingOptionsMode)) {
		throw new Error("invalid Discussion pendingOptionsMode");
	}
	const pendingOptionDescriptions = record.pendingOptionDescriptions;
	if (pendingOptionDescriptions !== undefined) {
		if (!Array.isArray(pendingOptionDescriptions) || pendingOptionDescriptions.some((entry) => typeof entry !== "string")) {
			throw new Error("invalid Discussion pendingOptionDescriptions");
		}
		if (!Array.isArray(pendingOptions) || pendingOptionDescriptions.length !== pendingOptions.length) {
			throw new Error("invalid Discussion pendingOptionDescriptions: must align 1:1 with pendingOptions");
		}
	}
	const pendingIsQuiz = record.pendingIsQuiz;
	if (pendingIsQuiz !== undefined && typeof pendingIsQuiz !== "boolean") throw new Error("invalid Discussion pendingIsQuiz");
	const pendingQuizRoundNumber = record.pendingQuizRoundNumber;
	if (
		pendingQuizRoundNumber !== undefined &&
		(typeof pendingQuizRoundNumber !== "number" || !Number.isInteger(pendingQuizRoundNumber) || pendingQuizRoundNumber < 1)
	) {
		throw new Error("invalid Discussion pendingQuizRoundNumber");
	}
	return {
		state: state as DiscussionState,
		roundCount,
		...(typeof record.deferredReason === "string" ? { deferredReason: record.deferredReason } : {}),
		...(typeof record.settlement === "string" ? { settlement: record.settlement } : {}),
		...(typeof record.settledAt === "string" ? { settledAt: record.settledAt } : {}),
		...(pendingOptions !== undefined ? { pendingOptions: pendingOptions as string[] } : {}),
		...(pendingOptionsMode !== undefined ? { pendingOptionsMode: pendingOptionsMode as DiscussionOptionsMode } : {}),
		...(pendingOptionDescriptions !== undefined ? { pendingOptionDescriptions: pendingOptionDescriptions as string[] } : {}),
		...(pendingIsQuiz !== undefined ? { pendingIsQuiz } : {}),
		...(pendingQuizRoundNumber !== undefined ? { pendingQuizRoundNumber } : {}),
	};
}
