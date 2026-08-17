import { DISCUSSION_ROUNDS_DEFAULT_LIMIT, DISCUSSION_ROUNDS_MAX_LIMIT } from "../constants.ts";
import type { Db } from "../db.ts";
import {
	type AppendDiscussionRound,
	type DiscussionOptionsMode,
	type DiscussionQuizResult,
	type DiscussionRound,
	type DiscussionRoundQuery,
	validateDiscussionActor,
	validateDiscussionContent,
	validateDiscussionOptions,
} from "../discussion/discussion.ts";
import type { DiscussionRoundStore } from "../discussion/discussion-round-store.ts";

// Deliberately excludes quiz_correct_options/quiz_explanation: those are the hidden columns only
// resolvePendingQuizAnswer's own dedicated, narrower query ever selects. This row type -- and the
// general-purpose SELECT below that populates it -- structurally cannot leak a quiz's answer,
// because the shape flowing through mapRow() never carries it in the first place.
interface DiscussionRoundRow {
	id: number;
	discussion_id: string;
	round_number: number;
	actor: string;
	content: string;
	occurred_at: string;
	options: string | null;
	options_mode: string | null;
	selected: string | null;
	option_descriptions: string | null;
	quiz: number | null;
	quiz_result_correct: number | null;
	quiz_result_correct_options: string | null;
	quiz_result_explanation: string | null;
}

function mapRow(row: DiscussionRoundRow): DiscussionRound {
	const quizResult: DiscussionQuizResult | undefined =
		row.quiz_result_correct !== null
			? {
					correct: row.quiz_result_correct === 1,
					correctOptions: JSON.parse(row.quiz_result_correct_options ?? "[]") as string[],
					explanation: row.quiz_result_explanation ?? "",
				}
			: undefined;
	return {
		id: row.id,
		discussionId: row.discussion_id,
		roundNumber: row.round_number,
		actor: row.actor,
		content: row.content,
		occurredAt: row.occurred_at,
		...(row.options !== null ? { options: JSON.parse(row.options) as string[] } : {}),
		...(row.options_mode !== null ? { optionsMode: row.options_mode as DiscussionOptionsMode } : {}),
		...(row.selected !== null ? { selected: JSON.parse(row.selected) as string[] } : {}),
		...(row.option_descriptions !== null ? { optionDescriptions: JSON.parse(row.option_descriptions) as string[] } : {}),
		...(row.quiz === 1 ? { quiz: true } : {}),
		...(quizResult ? { quizResult } : {}),
	};
}

export class SQLiteDiscussionRoundStore implements DiscussionRoundStore {
	constructor(private readonly db: Db) {}

	append(round: AppendDiscussionRound, occurredAt: string): DiscussionRound {
		const content = validateDiscussionContent(round.content);
		const actor = validateDiscussionActor(round.actor);
		// selected isn't validated here -- it requires cross-referencing the Discussion's
		// currently pending options (extra.discussion), which this store, deliberately scoped to
		// the rounds table alone, has no access to. discussion-service.ts validates it beforehand.
		const posed =
			round.options !== undefined || round.optionsMode !== undefined
				? validateDiscussionOptions(round.options ?? [], round.optionsMode ?? "", round.optionDescriptions)
				: undefined;
		// quizCorrectOptions/quizExplanation are NOT re-validated here -- discussion-service.ts already
		// ran validateDiscussionQuiz before this reaches the store, same trust boundary as `selected`
		// above. quizResult (the already-graded outcome) is likewise computed upstream, never here.
		const result = this.db
			.prepare(`
			INSERT INTO discussion_rounds (
				discussion_id, round_number, actor, content, occurred_at, event_schema_version,
				options, options_mode, selected, option_descriptions,
				quiz, quiz_correct_options, quiz_explanation,
				quiz_result_correct, quiz_result_correct_options, quiz_result_explanation
			)
			VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
			.run(
				round.discussionId,
				round.roundNumber,
				actor,
				content,
				occurredAt,
				posed ? JSON.stringify(posed.options) : null,
				posed ? posed.mode : null,
				round.selected !== undefined ? JSON.stringify(round.selected) : null,
				posed?.optionDescriptions ? JSON.stringify(posed.optionDescriptions) : null,
				round.quiz ? 1 : null,
				round.quizCorrectOptions !== undefined ? JSON.stringify(round.quizCorrectOptions) : null,
				round.quizExplanation ?? null,
				round.quizResult !== undefined ? (round.quizResult.correct ? 1 : 0) : null,
				round.quizResult !== undefined ? JSON.stringify(round.quizResult.correctOptions) : null,
				round.quizResult?.explanation ?? null,
			);
		return {
			id: Number(result.lastInsertRowid),
			discussionId: round.discussionId,
			roundNumber: round.roundNumber,
			actor,
			content,
			occurredAt,
			...(posed ? { options: posed.options, optionsMode: posed.mode } : {}),
			...(posed?.optionDescriptions ? { optionDescriptions: posed.optionDescriptions } : {}),
			...(round.selected !== undefined ? { selected: [...round.selected] } : {}),
			...(round.quiz ? { quiz: true as const } : {}),
			...(round.quizResult !== undefined
				? { quizResult: { ...round.quizResult, correctOptions: [...round.quizResult.correctOptions] } }
				: {}),
		};
	}

	list(query: DiscussionRoundQuery): DiscussionRound[] {
		const limit = Math.min(DISCUSSION_ROUNDS_MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DISCUSSION_ROUNDS_DEFAULT_LIMIT)));
		const rows = this.db
			.prepare(`
			SELECT id, discussion_id, round_number, actor, content, occurred_at, options, options_mode, selected, option_descriptions,
			       quiz, quiz_result_correct, quiz_result_correct_options, quiz_result_explanation
			FROM discussion_rounds
			WHERE discussion_id = ? AND round_number > ?
			ORDER BY round_number ASC
			LIMIT ?
		`)
			.all(query.discussionId, query.afterRound ?? 0, limit) as DiscussionRoundRow[];
		return rows.map(mapRow);
	}

	count(discussionId: string): number {
		return (this.db.prepare("SELECT COUNT(*) AS c FROM discussion_rounds WHERE discussion_id = ?").get(discussionId) as { c: number }).c;
	}

	// The one place quiz_correct_options/quiz_explanation are ever read back -- a narrow, dedicated
	// query naming exactly those two hidden columns, deliberately separate from list()'s own SELECT.
	resolvePendingQuizAnswer(discussionId: string, roundNumber: number): { correctOptions: string[]; explanation: string } | undefined {
		const row = this.db
			.prepare("SELECT quiz_correct_options, quiz_explanation FROM discussion_rounds WHERE discussion_id = ? AND round_number = ?")
			.get(discussionId, roundNumber) as { quiz_correct_options: string | null; quiz_explanation: string | null } | undefined;
		if (!row || row.quiz_correct_options === null || row.quiz_explanation === null) return undefined;
		return { correctOptions: JSON.parse(row.quiz_correct_options) as string[], explanation: row.quiz_explanation };
	}
}
