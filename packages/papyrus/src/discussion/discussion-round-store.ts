import type { AppendDiscussionRound, DiscussionRound, DiscussionRoundQuery } from "../discussion/discussion.ts";

/** Persistence port for a Discussion's append-only rounds (see domain/discussion.ts). */
export interface DiscussionRoundStore {
	append(round: AppendDiscussionRound, occurredAt: string): DiscussionRound;
	list(query: DiscussionRoundQuery): DiscussionRound[];
	count(discussionId: string): number;
	/**
	 * Reads back a quiz's hidden correct-answer + explanation, for grading only -- the one deliberate
	 * hole in "never expose the answer", scoped to discussion-service.ts's reply() alone. Returns
	 * undefined when that round never posed a quiz (defensive; discussion-service.ts only calls this
	 * when extra.discussion.pendingIsQuiz is already true, so this should always resolve in practice).
	 */
	resolvePendingQuizAnswer(discussionId: string, roundNumber: number): { correctOptions: string[]; explanation: string } | undefined;
}
