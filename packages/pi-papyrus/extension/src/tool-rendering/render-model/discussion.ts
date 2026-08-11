import { TOOL_DETAILS_MAX_ITEMS, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS } from "@danypops/papyrus";
import {
	type ArtifactSummarySource,
	artifactSummary,
	completeness,
	isBoundedString,
	isRecord,
	PAPYRUS_TOOL_DETAILS_SCHEMA,
	type ResultCompleteness,
	type ToolArtifactSummary,
	type ToolDetailsBase,
} from "./shared.ts";

export interface DiscussionRoundSummary {
	roundNumber: number;
	actor: string;
	content: string;
}

export interface DiscussionToolDetails extends ToolDetailsBase {
	kind: "discussion";
	/** Absent for discuss.rounds, which returns rounds with no parent discussion in its own output. */
	discussion?: ToolArtifactSummary;
	rounds: DiscussionRoundSummary[];
	completeness: ResultCompleteness;
}

export function createDiscussionDetails(
	operation: string,
	rounds: readonly DiscussionRoundSummary[],
	discussion?: ArtifactSummarySource,
): DiscussionToolDetails {
	const boundedRounds = rounds.slice(0, TOOL_DETAILS_MAX_ITEMS).map((round) => ({
		...round,
		content: round.content.slice(0, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS),
	}));
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "discussion",
		operation,
		...(discussion ? { discussion: artifactSummary(discussion) } : {}),
		rounds: boundedRounds,
		completeness: completeness(rounds.length, boundedRounds.length),
	};
}

export function isDiscussionRoundSummary(value: unknown): value is DiscussionRoundSummary {
	return isRecord(value) && Number.isSafeInteger(value.roundNumber) && isBoundedString(value.actor) && isBoundedString(value.content);
}
