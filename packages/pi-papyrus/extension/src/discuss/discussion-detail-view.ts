/**
 * discussion-detail-view.ts — the transcript view for a single Discussion.
 *
 * The generic artifact detail view (artifact/artifact-detail-view.ts) formats an artifact's own
 * fields (title, body, extra as JSON, edges); it has no way to show a Discussion's rounds,
 * since those live in a dedicated child table fetched separately (discuss.show / discuss.rounds),
 * not in the artifact row itself. Tasks needed the same kind of dedicated view for the same
 * underlying reason (task/task-detail-view.ts) -- this mirrors that scrolling-viewport idiom rather
 * than inventing a new one.
 */

import {
	ARTIFACT_DETAIL_MAX_VISIBLE_LINES,
	ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
	ARTIFACT_DETAIL_RESERVED_ROWS,
	type Artifact,
	type DiscussionRound,
	quizOptionLabel,
	readDiscussionExtra,
} from "@danypops/papyrus";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { DISCUSSION_STATE_PRESENTATION } from "../artifact/artifact-status-presentation.ts";
import { type ActiveTheme, renderMarkdownBody } from "../markdown.ts";

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
	private compactOffsetY = 0;
	private expandedOffsetY = 0;
	private expandedOffsetInitialized = false;
	private renderedWidth = 0;
	private lines: TranscriptLine[] = [];
	private readonly compactVisibleLines: number;
	private expanded = false;

	constructor(
		private readonly tui: TUI,
		private readonly activeTheme: ActiveTheme,
		private readonly discussion: Artifact,
		private readonly rounds: DiscussionRound[],
		private readonly close: () => void,
		private readonly matchesBinding: (data: string, binding: "up" | "down" | "pageUp" | "pageDown" | "cancel") => boolean,
	) {
		this.compactVisibleLines = Math.max(
			ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
			Math.min(ARTIFACT_DETAIL_MAX_VISIBLE_LINES, tui.terminal.rows - ARTIFACT_DETAIL_RESERVED_ROWS),
		);
	}

	invalidate(): void {
		this.renderedWidth = 0;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		this.buildLines(contentWidth);
		const visibleLines = this.visibleLineCount();
		const offsetY = Math.min(this.activeOffsetY(), Math.max(0, this.lines.length - visibleLines));
		const end = Math.min(this.lines.length, offsetY + visibleLines);
		const theme = this.activeTheme();
		const border = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const footer = [
			this.lines.length > visibleLines ? `j/k scroll · ${offsetY + 1}-${end}/${this.lines.length}` : "",
			`f ${this.expanded ? "compact" : "expand"}`,
			"q/Esc back",
		]
			.filter(Boolean)
			.join(" · ");
		return [
			border,
			truncateToWidth(theme.fg("accent", theme.bold("Discussion transcript")), width, ""),
			border,
			...this.lines.slice(offsetY, end).map((line) => truncateToWidth(` ${line.text}`, width, "")),
			truncateToWidth(theme.fg("dim", footer), width, ""),
			border,
		];
	}

	handleInput(data: string): void {
		if (this.matchesBinding(data, "cancel") || data === "q") {
			this.close();
			return;
		}
		const visibleLines = this.visibleLineCount();
		const offsetY = Math.min(this.activeOffsetY(), Math.max(0, this.lines.length - visibleLines));
		if (this.matchesBinding(data, "up") || data === "k") this.setActiveOffsetY(Math.max(0, offsetY - 1));
		else if (this.matchesBinding(data, "down") || data === "j")
			this.setActiveOffsetY(Math.min(Math.max(0, this.lines.length - visibleLines), offsetY + 1));
		else if (this.matchesBinding(data, "pageDown") || matchesKey(data, "ctrl+d"))
			this.setActiveOffsetY(Math.min(Math.max(0, this.lines.length - visibleLines), offsetY + Math.max(1, Math.floor(visibleLines / 2))));
		else if (this.matchesBinding(data, "pageUp") || matchesKey(data, "ctrl+u"))
			this.setActiveOffsetY(Math.max(0, offsetY - Math.max(1, Math.floor(visibleLines / 2))));
		else if (data === "g") this.setActiveOffsetY(0);
		else if (data === "G") this.setActiveOffsetY(Math.max(0, this.lines.length - visibleLines));
		else if (data === "f") {
			if (!this.expanded && !this.expandedOffsetInitialized) {
				this.expandedOffsetY = this.compactOffsetY;
				this.expandedOffsetInitialized = true;
			}
			this.expanded = !this.expanded;
		} else return;
		this.tui.requestRender();
	}

	private activeOffsetY(): number {
		return this.expanded ? this.expandedOffsetY : this.compactOffsetY;
	}

	private setActiveOffsetY(offsetY: number): void {
		if (this.expanded) this.expandedOffsetY = offsetY;
		else this.compactOffsetY = offsetY;
	}

	private visibleLineCount(): number {
		return this.expanded
			? Math.max(this.compactVisibleLines, this.tui.terminal.rows - ARTIFACT_DETAIL_RESERVED_ROWS)
			: this.compactVisibleLines;
	}

	private buildLines(width: number): void {
		if (this.renderedWidth === width) return;
		this.renderedWidth = width;
		const theme = this.activeTheme();
		const extra = (() => {
			try {
				return readDiscussionExtra(this.discussion.extra);
			} catch {
				return undefined;
			}
		})();
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
			const roundHeader =
				theme.fg("accent", `[round ${round.roundNumber}] `) + theme.bold(round.actor) + theme.fg("dim", ` · ${round.occurredAt}`);
			const body = renderMarkdownBody(round.content, width - 2, this.activeTheme).map((line) => ({ text: `  ${line}` }));
			// Quiz options get lettered (A, B, C, ...) and a distinct "Quiz" label; a plain, non-quiz posed
			// choice keeps its existing comma-joined "Posed" presentation unchanged (backward compatible).
			const posed =
				round.options && round.options.length > 0
					? [
							{
								text: `  ${theme.fg(
									"muted",
									round.quiz
										? `Quiz (${round.optionsMode === "multi" ? "pick all that apply" : "pick one"}): ${round.options
												.map((option, optionIndex) => `${quizOptionLabel(optionIndex)}. ${option}`)
												.join("  ")}`
										: `Posed (${round.optionsMode === "multi" ? "pick several" : "pick one"}): ${round.options.join(", ")}`,
								)}`,
							},
						]
					: [];
			const picked =
				round.selected && round.selected.length > 0 ? [{ text: `  ${theme.fg("success", `Selected: ${round.selected.join(", ")}`)}` }] : [];
			// The graded verdict -- always includes the explanation, especially when wrong. Only ever
			// present on the round that actually answered a pending quiz (see domain/discussion.ts).
			const quizVerdict = round.quizResult
				? [
						{
							text: `  ${theme.fg(
								round.quizResult.correct ? "success" : "error",
								round.quizResult.correct
									? "✅ Correct!"
									: `❌ Incorrect -- correct answer(s): ${round.quizResult.correctOptions.join(", ")}.`,
							)}`,
						},
						{ text: `  ${theme.fg("muted", round.quizResult.explanation)}` },
					]
				: [];
			return [
				{ text: roundHeader },
				...body,
				...posed,
				...picked,
				...quizVerdict,
				...(index < this.rounds.length - 1 ? [{ text: "" }] : []),
			];
		});
		this.lines = [...header, ...(transcript.length > 0 ? transcript : [{ text: theme.fg("muted", "No rounds recorded.") }])];
	}
}

export async function showDiscussionDetailView(
	ctx: ExtensionCommandContext,
	discussion: Artifact,
	rounds: DiscussionRound[],
): Promise<void> {
	if (ctx.mode !== "tui") {
		const lines = rounds.map((round) => `[round ${round.roundNumber}] ${round.actor}: ${round.content}`);
		ctx.ui.notify([discussion.title, ...lines].join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new DiscussionTranscriptViewport(
				tui,
				() => ctx.ui.theme ?? theme,
				discussion,
				rounds,
				done,
				(data, binding) => {
					if (binding === "up") return keybindings.matches?.(data, "tui.select.up") === true || matchesKey(data, "up");
					if (binding === "down") return keybindings.matches?.(data, "tui.select.down") === true || matchesKey(data, "down");
					if (binding === "pageUp") return keybindings.matches?.(data, "tui.select.pageUp") === true || matchesKey(data, "pageUp");
					if (binding === "pageDown") return keybindings.matches?.(data, "tui.select.pageDown") === true || matchesKey(data, "pageDown");
					return keybindings.matches?.(data, "tui.select.cancel") === true || matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
				},
			),
	);
}
