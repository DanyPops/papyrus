import type { AppendDiscussionRound, DiscussionRound, DiscussionRoundQuery } from "../domain/discussion.ts";

/** Persistence port for a Discussion's append-only rounds (see domain/discussion.ts). */
export interface DiscussionRoundStore {
	append(round: AppendDiscussionRound, occurredAt: string): DiscussionRound;
	list(query: DiscussionRoundQuery): DiscussionRound[];
	count(discussionId: string): number;
}
