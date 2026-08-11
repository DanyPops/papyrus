import type { Artifact } from "@danypops/papyrus";
import { expandHint } from "@danypops/vehicle-client-pi/expand-hint";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, type DetailSection, statelessComponent } from "malevich-tui-components";
import { detailViewTheme, measure, statusColor, statusGlyph } from "../../tool-rendering/artifact-card.ts";
import { isArtifact, isArtifactArray, type RenderableDiscussionParent } from "./shared.ts";

/** A Discussion round -- discuss.open/reply/show/rounds' own transcript entry. Detected the
 * same name-independent, shape-based way as the others in this directory. */
export interface DiscussionRoundOutput {
	roundNumber: number;
	actor: string;
	content: string;
}

export function isDiscussionRound(value: unknown): value is DiscussionRoundOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row.roundNumber === "number" && typeof row.actor === "string" && typeof row.content === "string";
}

export function isDiscussionRoundArray(value: unknown): value is DiscussionRoundOutput[] {
	return Array.isArray(value) && value.every(isDiscussionRound);
}

export interface DiscussionAndRoundsOutput {
	discussion: Artifact;
	rounds: DiscussionRoundOutput[];
}

export function isDiscussionAndRounds(value: unknown): value is DiscussionAndRoundsOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return isArtifact(row.discussion) && isDiscussionRoundArray(row.rounds);
}

export interface DiscussionRoundsOnlyOutput {
	rounds: DiscussionRoundOutput[];
}

export function isDiscussionRoundsOnly(value: unknown): value is DiscussionRoundsOnlyOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return row.discussion === undefined && isDiscussionRoundArray(row.rounds);
}

export interface DiscussionListOutput {
	discussions: Artifact[];
}

export function isDiscussionListOutput(value: unknown): value is DiscussionListOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return isArtifactArray(row.discussions);
}

export function roundsSection(rounds: readonly DiscussionRoundOutput[]): DetailSection {
	return {
		heading: `Rounds (${rounds.length}):`,
		items: rounds.map((round) => ({ byline: `${round.actor} · round ${round.roundNumber}`, body: round.content })),
	};
}

export function renderDiscussionAndRounds(
	output: { discussion: RenderableDiscussionParent; rounds: readonly DiscussionRoundOutput[] },
	theme: Theme,
	expanded: boolean,
): Component {
	const discussion = output.discussion;
	return statelessComponent((width) => {
		const safeWidth = Math.max(1, width);
		const fields: DetailField[] = [
			{ label: "Title", value: discussion.title },
			{ label: "Status", value: theme.fg(statusColor(discussion.status), `${statusGlyph(discussion.status)} ${discussion.status}`) },
		];
		const sections: DetailSection[] = expanded && output.rounds.length > 0 ? [roundsSection(output.rounds)] : [];
		const lines = buildDetailLines(safeWidth, { fields, sections, alignFields: true, theme: detailViewTheme(theme), measure });
		if (!expanded && output.rounds.length > 0) {
			const count = output.rounds.length;
			lines.push(truncateToWidth(theme.fg("dim", `${count} round${count === 1 ? "" : "s"} · ${expandHint()}`), safeWidth));
		}
		return lines;
	});
}

export function renderDiscussionRoundsOnly(output: DiscussionRoundsOnlyOutput, theme: Theme): Component {
	return statelessComponent((width) => {
		const sections: DetailSection[] = output.rounds.length > 0 ? [roundsSection(output.rounds)] : [{ lines: ["No rounds."] }];
		return buildDetailLines(Math.max(1, width), { sections, theme: detailViewTheme(theme), measure });
	});
}
