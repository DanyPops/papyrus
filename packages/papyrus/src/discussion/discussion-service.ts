/**
 * Discuss: application service composing the Discussion Doc (via ArtifactStore) with its
 * append-only rounds (via DiscussionRoundStore). See domain/discussion.ts for the full
 * design rationale.
 */

import type { Artifact } from "../artifact/artifact.ts";
import type { ArtifactEventContext } from "../artifact/artifact-event.ts";
import type { AtomicArtifactStore } from "../artifact/atomic-artifact-store.ts";
import { DISCUSSION_LIST_DEFAULT_LIMIT, DISCUSSION_LIST_MAX_LIMIT, DISCUSSION_MAX_ROUNDS } from "../constants.ts";
import {
	DISCUSSION_SUBTYPE,
	type DiscussionExtra,
	type DiscussionOptionsMode,
	type DiscussionQuizResult,
	type DiscussionRound,
	gradeQuizAnswer,
	isDiscussionArtifact,
	readDiscussionExtra,
	validateDeferReason,
	validateDiscussionActor,
	validateDiscussionContent,
	validateDiscussionOptions,
	validateDiscussionQuiz,
	validateSelectedOptions,
	validateSettlement,
} from "./discussion.ts";
import type { DiscussionRoundStore } from "./discussion-round-store.ts";

export class DiscussionError extends Error {}

export interface OpenDiscussionInput {
	title: string;
	actor: string;
	content: string;
	body?: string;
	labels?: string[];
	blocksTaskIds?: string[];
	/** Poses a choice on round 1 -- both or neither; see domain/discussion.ts's DiscussionOptionsMode. */
	options?: string[];
	optionsMode?: DiscussionOptionsMode;
	/** Index-aligned with options -- see domain/discussion.ts's pendingOptionDescriptions. */
	optionDescriptions?: string[];
	/** Turns the posed choice into a graded quiz -- both required together, alongside options/optionsMode.
	 * See domain/discussion.ts's validateDiscussionQuiz. */
	quizCorrectOptions?: string[];
	quizExplanation?: string;
}

export interface ReplyInput {
	actor: string;
	content: string;
	/** Answers the Discussion's currently pending posed choice, if any; validated against it. If the
	 * pending choice was a quiz, this is also graded automatically -- see the round's own quizResult. */
	selected?: string[];
	/** Poses a new choice on this same round, replacing whatever was previously pending. */
	options?: string[];
	optionsMode?: DiscussionOptionsMode;
	optionDescriptions?: string[];
	/** Turns the newly-posed choice into a graded quiz -- both required together. */
	quizCorrectOptions?: string[];
	quizExplanation?: string;
}

export interface DiscussionAndRounds {
	discussion: Artifact;
	rounds: DiscussionRound[];
}

function requireDiscussion(artifact: Artifact | null, id: string): Artifact {
	if (!artifact) throw new DiscussionError(`discussion "${id}" not found`);
	if (!isDiscussionArtifact(artifact)) throw new DiscussionError(`artifact "${id}" is not a Discussion`);
	return artifact;
}

export class Discussions {
	constructor(
		private readonly artifacts: AtomicArtifactStore,
		private readonly rounds: DiscussionRoundStore,
	) {}

	private extra(discussion: Artifact): DiscussionExtra {
		return readDiscussionExtra(discussion.extra);
	}

	/**
	 * Validates a freshly-posed choice; undefined when nothing is posed at all (neither options nor
	 * quiz fields given), since both/neither is the only valid shape. correct_options/explanation
	 * turn the choice into a graded quiz -- both required together, and only once options/optionsMode
	 * are also given.
	 */
	private validatePosedOptions(
		options: string[] | undefined,
		optionsMode: DiscussionOptionsMode | undefined,
		optionDescriptions: string[] | undefined,
		quizCorrectOptions: string[] | undefined,
		quizExplanation: string | undefined,
	):
		| {
				options: string[];
				mode: DiscussionOptionsMode;
				optionDescriptions?: string[];
				quiz?: { correctOptions: string[]; explanation: string };
		  }
		| undefined {
		if (options === undefined && optionsMode === undefined) {
			if (quizCorrectOptions !== undefined || quizExplanation !== undefined) {
				throw new Error("correct_options/explanation require options and options_mode to also be posed");
			}
			return undefined;
		}
		const posed = validateDiscussionOptions(options ?? [], optionsMode ?? "", optionDescriptions);
		if (quizCorrectOptions === undefined && quizExplanation === undefined) return posed;
		if (quizCorrectOptions === undefined || quizExplanation === undefined) {
			throw new Error("correct_options and explanation must both be given to pose a quiz, or neither");
		}
		return { ...posed, quiz: validateDiscussionQuiz(posed.options, posed.mode, quizCorrectOptions, quizExplanation) };
	}

	open(input: OpenDiscussionInput, context?: ArtifactEventContext): DiscussionAndRounds {
		const actor = validateDiscussionActor(input.actor);
		const content = validateDiscussionContent(input.content);
		const posed = this.validatePosedOptions(
			input.options,
			input.optionsMode,
			input.optionDescriptions,
			input.quizCorrectOptions,
			input.quizExplanation,
		);
		return this.artifacts.atomic(() => {
			const discussion = this.artifacts.create(
				{
					kind: "task",
					subtype: DISCUSSION_SUBTYPE,
					title: input.title,
					body: input.body ?? "",
					status: "in-progress",
					labels: input.labels,
					extra: {
						discussion: {
							state: "active",
							roundCount: 1,
							...(posed
								? {
										pendingOptions: posed.options,
										pendingOptionsMode: posed.mode,
										...(posed.optionDescriptions ? { pendingOptionDescriptions: posed.optionDescriptions } : {}),
										...(posed.quiz ? { pendingIsQuiz: true, pendingQuizRoundNumber: 1 } : {}),
									}
								: {}),
						},
					},
				},
				context,
			);
			const round = this.rounds.append(
				{
					discussionId: discussion.id,
					roundNumber: 1,
					actor,
					content,
					...(posed
						? {
								options: posed.options,
								optionsMode: posed.mode,
								...(posed.optionDescriptions ? { optionDescriptions: posed.optionDescriptions } : {}),
								...(posed.quiz
									? { quiz: true, quizCorrectOptions: posed.quiz.correctOptions, quizExplanation: posed.quiz.explanation }
									: {}),
							}
						: {}),
				},
				new Date().toISOString(),
			);
			for (const taskId of input.blocksTaskIds ?? []) this.block(discussion.id, taskId, context);
			return { discussion: this.artifacts.get(discussion.id)!, rounds: [round] };
		});
	}

	reply(discussionId: string, input: ReplyInput, context?: ArtifactEventContext): DiscussionAndRounds {
		const validActor = validateDiscussionActor(input.actor);
		const validContent = validateDiscussionContent(input.content);
		const posed = this.validatePosedOptions(
			input.options,
			input.optionsMode,
			input.optionDescriptions,
			input.quizCorrectOptions,
			input.quizExplanation,
		);
		return this.artifacts.atomic(() => {
			const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
			const state = this.extra(discussion);
			if (state.state !== "active") throw new DiscussionError(`discussion "${discussionId}" is ${state.state}; resume it before replying`);
			if (state.roundCount >= DISCUSSION_MAX_ROUNDS)
				throw new DiscussionError(`discussion "${discussionId}" has reached its ${DISCUSSION_MAX_ROUNDS}-round limit; settle or defer it`);
			const selected =
				input.selected !== undefined ? validateSelectedOptions(input.selected, state.pendingOptions, state.pendingOptionsMode) : undefined;
			// Grading happens right here, inside this same transaction: the hidden answer is read via
			// resolvePendingQuizAnswer (the one deliberate hole in "never expose the quiz's answer",
			// scoped to exactly this call) and immediately folded into a safe, already-graded quizResult --
			// nothing upstream of this method ever sees the raw correct-options set for an unanswered quiz.
			const quizResult: DiscussionQuizResult | undefined =
				selected && state.pendingIsQuiz && state.pendingQuizRoundNumber !== undefined
					? (() => {
							const hidden = this.rounds.resolvePendingQuizAnswer(discussionId, state.pendingQuizRoundNumber as number);
							if (!hidden) {
								throw new DiscussionError(`discussion "${discussionId}" has no recorded quiz answer for its pending round`);
							}
							return {
								correct: gradeQuizAnswer(selected, hidden.correctOptions),
								correctOptions: hidden.correctOptions,
								explanation: hidden.explanation,
							};
						})()
					: undefined;
			const nextRound = state.roundCount + 1;
			const round = this.rounds.append(
				{
					discussionId,
					roundNumber: nextRound,
					actor: validActor,
					content: validContent,
					...(posed
						? {
								options: posed.options,
								optionsMode: posed.mode,
								...(posed.optionDescriptions ? { optionDescriptions: posed.optionDescriptions } : {}),
								...(posed.quiz
									? { quiz: true, quizCorrectOptions: posed.quiz.correctOptions, quizExplanation: posed.quiz.explanation }
									: {}),
							}
						: {}),
					...(selected ? { selected } : {}),
					...(quizResult ? { quizResult } : {}),
				},
				new Date().toISOString(),
			);
			// Whenever this round answers the pending choice OR poses a new one, the base must drop ALL
			// pending* fields first -- otherwise a re-pose that omits descriptions this time would
			// leave a stale pendingOptionDescriptions array (sized for the OLD options) spread through
			// unchanged, no longer aligned 1:1 with the new pendingOptions (and likewise for a stale
			// pendingIsQuiz/pendingQuizRoundNumber pointing at a round that's no longer pending). Only a
			// plain reply that neither answers nor re-poses leaves the existing pending state untouched.
			const {
				pendingOptions: _clearedOptions,
				pendingOptionsMode: _clearedMode,
				pendingOptionDescriptions: _clearedDescriptions,
				pendingIsQuiz: _clearedIsQuiz,
				pendingQuizRoundNumber: _clearedQuizRoundNumber,
				...withoutPending
			} = state;
			const nextState = {
				...(selected || posed ? withoutPending : state),
				roundCount: nextRound,
				...(posed
					? {
							pendingOptions: posed.options,
							pendingOptionsMode: posed.mode,
							...(posed.optionDescriptions ? { pendingOptionDescriptions: posed.optionDescriptions } : {}),
							...(posed.quiz ? { pendingIsQuiz: true, pendingQuizRoundNumber: nextRound } : {}),
						}
					: {}),
			};
			const updated = this.artifacts.setExtra(discussionId, { ...discussion.extra, discussion: nextState }, context)!;
			return { discussion: updated, rounds: [round] };
		});
	}

	defer(discussionId: string, reason?: string, context?: ArtifactEventContext): Artifact {
		const validReason = reason === undefined ? undefined : validateDeferReason(reason);
		return this.artifacts.atomic(() => {
			const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
			const state = this.extra(discussion);
			if (state.state !== "active")
				throw new DiscussionError(`discussion "${discussionId}" is ${state.state}; only an active Discussion can be deferred`);
			return this.artifacts.setExtra(
				discussionId,
				{
					...discussion.extra,
					discussion: { ...state, state: "deferred", ...(validReason === undefined ? {} : { deferredReason: validReason }) },
				},
				context,
			)!;
		});
	}

	resume(discussionId: string, context?: ArtifactEventContext): Artifact {
		return this.artifacts.atomic(() => {
			const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
			const state = this.extra(discussion);
			if (state.state !== "deferred")
				throw new DiscussionError(`discussion "${discussionId}" is ${state.state}; only a deferred Discussion can be resumed`);
			const { deferredReason: _deferredReason, ...rest } = state;
			return this.artifacts.setExtra(discussionId, { ...discussion.extra, discussion: { ...rest, state: "active" } }, context)!;
		});
	}

	settle(discussionId: string, settlement: string, context?: ArtifactEventContext): Artifact {
		const validSettlement = validateSettlement(settlement);
		return this.artifacts.atomic(() => {
			const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
			const state = this.extra(discussion);
			if (state.state === "settled") throw new DiscussionError(`discussion "${discussionId}" is already settled`);
			const updated = this.artifacts.setExtra(
				discussionId,
				{
					...discussion.extra,
					discussion: { ...state, state: "settled", settlement: validSettlement, settledAt: new Date().toISOString() },
				},
				context,
			)!;
			return this.artifacts.setStatus(discussionId, "done", context) ?? updated;
		});
	}

	/** Links an existing active Discussion to a Task it blocks; refuses a non-task target or an already-settled Discussion. */
	block(discussionId: string, taskId: string, context?: ArtifactEventContext): void {
		const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
		if (this.extra(discussion).state === "settled")
			throw new DiscussionError(`discussion "${discussionId}" is settled; it can no longer block anything`);
		const task = this.artifacts.get(taskId);
		if (!task) throw new DiscussionError(`task "${taskId}" not found`);
		if (task.kind !== "task" || isDiscussionArtifact(task)) throw new DiscussionError(`artifact "${taskId}" is not a task`);
		this.artifacts.link({ from: discussionId, relation: "blocks", to: taskId }, context);
	}

	/** Idempotent: unblocking an already-absent relationship is a no-op. */
	unblock(discussionId: string, taskId: string, context?: ArtifactEventContext): boolean {
		return this.artifacts.unlink({ from: discussionId, relation: "blocks", to: taskId }, context);
	}

	show(discussionId: string): DiscussionAndRounds {
		const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
		// DISCUSSION_MAX_ROUNDS is the hard cap enforced at reply() time, so fetching exactly that
		// many always returns the complete transcript -- never the round store's own smaller
		// default page size, which would silently drop the tail of a long deliberation.
		return { discussion, rounds: this.rounds.list({ discussionId, limit: DISCUSSION_MAX_ROUNDS }) };
	}

	listRounds(discussionId: string, afterRound?: number, limit?: number): DiscussionRound[] {
		requireDiscussion(this.artifacts.get(discussionId), discussionId);
		return this.rounds.list({ discussionId, afterRound, limit });
	}

	list(filter: { state?: string; limit?: number } = {}): Artifact[] {
		// DISCUSSION_LIST_MAX_LIMIT/DEFAULT_LIMIT exist specifically so an unqualified discuss.list
		// (limit omitted) can never fall through to queryArtifacts' own unbounded default -- the same
		// class of gap notes.ts's noteListInput comment documents fixing for Notes.
		const limit = Math.min(DISCUSSION_LIST_MAX_LIMIT, Math.max(1, Math.floor(filter.limit ?? DISCUSSION_LIST_DEFAULT_LIMIT)));
		const rows = this.artifacts.query({ kind: "task", subtype: DISCUSSION_SUBTYPE, limit });
		if (!filter.state) return rows;
		return rows.filter((row) => {
			try {
				return this.extra(row).state === filter.state;
			} catch {
				return false;
			}
		});
	}
}
