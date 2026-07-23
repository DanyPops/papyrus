/**
 * discussion-detail-view.ts — the transcript view for a single Discussion.
 *
 * The generic artifact detail view (artifact-detail-view.ts) formats an artifact's own
 * fields (title, body, extra as JSON, edges); it has no way to show a Discussion's rounds,
 * since those live in a dedicated child table fetched separately (discuss.show / discuss.rounds),
 * not in the artifact row itself. Tasks needed the same kind of dedicated view for the same
 * underlying reason (task-detail-view.ts) -- this mirrors that scrolling-viewport idiom rather
 * than inventing a new one.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
	ARTIFACT_DETAIL_MAX_VISIBLE_LINES,
	ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
	ARTIFACT_DETAIL_RESERVED_ROWS,
} from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import { readDiscussionExtra, type DiscussionRound } from "../../src/domain/discussion.ts";
import { renderMarkdownBody, type ActiveTheme } from "./markdown.ts";
import { DISCUSSION_STATE_PRESENTATION } from "./artifact-status-presentation.ts";

interface TranscriptLine {
	text: string;
}

/** Reads state defensively for display -- a corrupt/foreign extra.discussion shape shows as "unknown" rather than crashing the whole panel over one bad row. */
export function discussionStateOf(discussion: Artifact): string {
	try {
		return readDiscussionExtra(discussion.extra).state;
	} catch {
		return "unknown";
	}
}

export function discussionRoundCountOf(discussion: Artifact): number {
	try {
		return readDiscussionExtra(discussion.extra).roundCount;
	} catch {
		return 0;
	}
}

class DiscussionTranscriptViewport {
	private offsetY = 0;
	private renderedWidth = 0;
	private lines: TranscriptLine[] = [];
	private readonly visibleLines: number;

	constructor(
		private readonly tui: TUI,
		private readonly activeTheme: ActiveTheme,
		private readonly discussion: Artifact,
		private readonly rounds: DiscussionRound[],
		private readonly close: () => void,
	) {
		this.visibleLines = Math.max(
			ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
			Math.min(ARTIFACT_DETAIL_MAX_VISIBLE_LINES, tui.terminal.rows - ARTIFACT_DETAIL_RESERVED_ROWS),
		);
	}

	invalidate(): void { this.renderedWidth = 0; }

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		this.buildLines(contentWidth);
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - this.visibleLines));
		const end = Math.min(this.lines.length, this.offsetY + this.visibleLines);
		const theme = this.activeTheme();
		const border = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const footer = [
			this.lines.length > this.visibleLines ? `↑/↓ scroll · ${this.offsetY + 1}-${end}/${this.lines.length}` : "",
			"Esc back",
		].filter(Boolean).join(" · ");
		return [
			border,
			truncateToWidth(theme.fg("accent", theme.bold("Discussion transcript")), width, ""),
			border,
			...this.lines.slice(this.offsetY, end).map((line) => truncateToWidth(` ${line.text}`, width, "")),
			truncateToWidth(theme.fg("dim", footer), width, ""),
			border,
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.close(); return; }
		if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
		else if (matchesKey(data, "down")) this.offsetY = Math.min(Math.max(0, this.lines.length - this.visibleLines), this.offsetY + 1);
		else if (matchesKey(data, "pageDown")) this.offsetY = Math.min(Math.max(0, this.lines.length - this.visibleLines), this.offsetY + this.visibleLines);
		else if (matchesKey(data, "pageUp")) this.offsetY = Math.max(0, this.offsetY - this.visibleLines);
		else return;
		this.tui.requestRender();
	}

	private buildLines(width: number): void {
		if (this.renderedWidth === width) return;
		this.renderedWidth = width;
		const theme = this.activeTheme();
		const extra = (() => { try { return readDiscussionExtra(this.discussion.extra); } catch { return undefined; } })();
		const presentation = extra ? DISCUSSION_STATE_PRESENTATION[extra.state] : undefined;
		const stateLine = presentation
			? theme.fg(presentation.color, `${presentation.glyph} ${presentation.label}`)
			: theme.fg("muted", "state unknown");
		const header: TranscriptLine[] = [
			{ text: theme.bold(this.discussion.title) },
			{ text: `${stateLine}${theme.fg("dim", ` · ${this.discussion.id}`)}` },
			...(extra?.deferredReason ? [{ text: theme.fg("muted", `Deferred: ${extra.deferredReason}`) }] : []),
			...(extra?.settlement ? [{ text: theme.fg("success", `Settled: ${extra.settlement}`) }] : []),
			{ text: "" },
		];
		const transcript: TranscriptLine[] = this.rounds.flatMap((round, index) => {
			const roundHeader = theme.fg("accent", `[round ${round.roundNumber}] `) + theme.bold(round.actor) + theme.fg("dim", ` · ${round.occurredAt}`);
			const body = renderMarkdownBody(round.content, width - 2, this.activeTheme).map((line) => ({ text: `  ${line}` }));
			const posed = round.options && round.options.length > 0
				? [{ text: `  ${theme.fg("muted", `Posed (${round.optionsMode === "multi" ? "pick several" : "pick one"}): ${round.options.join(", ")}`)}` }]
				: [];
			const picked = round.selected && round.selected.length > 0
				? [{ text: `  ${theme.fg("success", `Selected: ${round.selected.join(", ")}`)}` }]
				: [];
			return [{ text: roundHeader }, ...body, ...posed, ...picked, ...(index < this.rounds.length - 1 ? [{ text: "" }] : [])];
		});
		this.lines = [...header, ...(transcript.length > 0 ? transcript : [{ text: theme.fg("muted", "No rounds recorded.") }])];
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - this.visibleLines));
	}
}

export async function showDiscussionDetailView(ctx: ExtensionCommandContext, discussion: Artifact, rounds: DiscussionRound[]): Promise<void> {
	if (ctx.mode !== "tui") {
		const lines = rounds.map((round) => `[round ${round.roundNumber}] ${round.actor}: ${round.content}`);
		ctx.ui.notify([discussion.title, ...lines].join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new DiscussionTranscriptViewport(tui, () => ctx.ui.theme ?? theme, discussion, rounds, done));
}
