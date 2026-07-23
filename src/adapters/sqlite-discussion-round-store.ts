import type { Db } from "../db.ts";
import { DISCUSSION_ROUNDS_DEFAULT_LIMIT, DISCUSSION_ROUNDS_MAX_LIMIT } from "../constants.ts";
import {
	validateDiscussionActor,
	validateDiscussionContent,
	validateDiscussionOptions,
	type AppendDiscussionRound,
	type DiscussionOptionsMode,
	type DiscussionRound,
	type DiscussionRoundQuery,
} from "../domain/discussion.ts";
import type { DiscussionRoundStore } from "../ports/discussion-round-store.ts";

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
}

function mapRow(row: DiscussionRoundRow): DiscussionRound {
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
		const posed = round.options !== undefined || round.optionsMode !== undefined
			? validateDiscussionOptions(round.options ?? [], round.optionsMode ?? "")
			: undefined;
		const result = this.db.prepare(`
			INSERT INTO discussion_rounds (discussion_id, round_number, actor, content, occurred_at, event_schema_version, options, options_mode, selected)
			VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
		`).run(
			round.discussionId, round.roundNumber, actor, content, occurredAt,
			posed ? JSON.stringify(posed.options) : null,
			posed ? posed.mode : null,
			round.selected !== undefined ? JSON.stringify(round.selected) : null,
		);
		return {
			id: Number(result.lastInsertRowid),
			discussionId: round.discussionId,
			roundNumber: round.roundNumber,
			actor,
			content,
			occurredAt,
			...(posed ? { options: posed.options, optionsMode: posed.mode } : {}),
			...(round.selected !== undefined ? { selected: [...round.selected] } : {}),
		};
	}

	list(query: DiscussionRoundQuery): DiscussionRound[] {
		const limit = Math.min(DISCUSSION_ROUNDS_MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DISCUSSION_ROUNDS_DEFAULT_LIMIT)));
		const rows = this.db.prepare(`
			SELECT id, discussion_id, round_number, actor, content, occurred_at, options, options_mode, selected
			FROM discussion_rounds
			WHERE discussion_id = ? AND round_number > ?
			ORDER BY round_number ASC
			LIMIT ?
		`).all(query.discussionId, query.afterRound ?? 0, limit) as DiscussionRoundRow[];
		return rows.map(mapRow);
	}

	count(discussionId: string): number {
		return (this.db.prepare("SELECT COUNT(*) AS c FROM discussion_rounds WHERE discussion_id = ?").get(discussionId) as { c: number }).c;
	}
}
