import type { Db } from "../db.ts";
import { DISCUSSION_ROUNDS_DEFAULT_LIMIT, DISCUSSION_ROUNDS_MAX_LIMIT } from "../constants.ts";
import { validateDiscussionActor, validateDiscussionContent, type AppendDiscussionRound, type DiscussionRound, type DiscussionRoundQuery } from "../domain/discussion.ts";
import type { DiscussionRoundStore } from "../ports/discussion-round-store.ts";

interface DiscussionRoundRow {
	id: number;
	discussion_id: string;
	round_number: number;
	actor: string;
	content: string;
	occurred_at: string;
}

function mapRow(row: DiscussionRoundRow): DiscussionRound {
	return {
		id: row.id,
		discussionId: row.discussion_id,
		roundNumber: row.round_number,
		actor: row.actor,
		content: row.content,
		occurredAt: row.occurred_at,
	};
}

export class SQLiteDiscussionRoundStore implements DiscussionRoundStore {
	constructor(private readonly db: Db) {}

	append(round: AppendDiscussionRound, occurredAt: string): DiscussionRound {
		const content = validateDiscussionContent(round.content);
		const actor = validateDiscussionActor(round.actor);
		const result = this.db.prepare(`
			INSERT INTO discussion_rounds (discussion_id, round_number, actor, content, occurred_at, event_schema_version)
			VALUES (?, ?, ?, ?, ?, 1)
		`).run(round.discussionId, round.roundNumber, actor, content, occurredAt);
		return {
			id: Number(result.lastInsertRowid),
			discussionId: round.discussionId,
			roundNumber: round.roundNumber,
			actor,
			content,
			occurredAt,
		};
	}

	list(query: DiscussionRoundQuery): DiscussionRound[] {
		const limit = Math.min(DISCUSSION_ROUNDS_MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DISCUSSION_ROUNDS_DEFAULT_LIMIT)));
		const rows = this.db.prepare(`
			SELECT id, discussion_id, round_number, actor, content, occurred_at
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
