import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import {
	ARTIFACT_DETAIL_HORIZONTAL_PAN_COLUMNS,
	ARTIFACT_DETAIL_MAX_VISIBLE_LINES,
	ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
	ARTIFACT_DETAIL_RESERVED_ROWS,
} from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import { artifactDetailContent, artifactDetailsText, type ArtifactDetailContent } from "./artifact-detail-format.ts";
import { renderMarkdownBody, type ActiveTheme } from "./markdown.ts";

interface ArtifactDetailLine {
	text: string;
	wide: boolean;
}

class ArtifactDetailViewport {
	private offsetX = 0;
	private offsetY = 0;
	private renderedWidth = 0;
	private lines: ArtifactDetailLine[] = [];
	private readonly visibleLines: number;
	private readonly content: ArtifactDetailContent;

	constructor(
		private readonly tui: TUI,
		private readonly activeTheme: ActiveTheme,
		artifact: Artifact,
		private readonly close: () => void,
	) {
		this.visibleLines = Math.max(
			ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
			Math.min(ARTIFACT_DETAIL_MAX_VISIBLE_LINES, tui.terminal.rows - ARTIFACT_DETAIL_RESERVED_ROWS),
		);
		this.content = artifactDetailContent(artifact);
	}

	invalidate(): void { this.renderedWidth = 0; }

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		this.buildLines(contentWidth);
		const wideWidth = this.content.relationships.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
		this.offsetX = Math.min(this.offsetX, Math.max(0, wideWidth - contentWidth));
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - this.visibleLines));
		const end = Math.min(this.lines.length, this.offsetY + this.visibleLines);
		const theme = this.activeTheme();
		const border = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const footer = [
			wideWidth > contentWidth ? `←/→ relationships · column ${this.offsetX + 1}/${wideWidth}` : "",
			this.lines.length > this.visibleLines ? `↑/↓ scroll · ${this.offsetY + 1}-${end}/${this.lines.length}` : "",
			"Esc back",
		].filter(Boolean).join(" · ");
		return [
			border,
			truncateToWidth(theme.fg("accent", theme.bold("Artifact details")), width, ""),
			border,
			...this.lines.slice(this.offsetY, end).map((line) => line.wide
				? ` ${sliceByColumn(line.text, this.offsetX, contentWidth, true)}`
				: truncateToWidth(` ${line.text}`, width, "")),
			truncateToWidth(theme.fg("dim", footer), width, ""),
			border,
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.close(); return; }
		if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
		else if (matchesKey(data, "down")) this.offsetY = Math.min(Math.max(0, this.lines.length - this.visibleLines), this.offsetY + 1);
		else if (matchesKey(data, "left")) this.offsetX = Math.max(0, this.offsetX - ARTIFACT_DETAIL_HORIZONTAL_PAN_COLUMNS);
		else if (matchesKey(data, "right")) this.offsetX += ARTIFACT_DETAIL_HORIZONTAL_PAN_COLUMNS;
		else return;
		this.tui.requestRender();
	}

	private buildLines(width: number): void {
		if (this.renderedWidth === width) return;
		this.renderedWidth = width;
		const theme = this.activeTheme();
		const wrap = (text: string, color: "text" | "muted" | "dim" = "text"): ArtifactDetailLine[] =>
			(text.length === 0 ? [""] : wrapTextWithAnsi(theme.fg(color, text), width)).map((line) => ({ text: line, wide: false }));
		const identity = [
			...wrap(theme.bold(this.content.title)),
			...wrap(this.content.identity, "muted"),
			{ text: "", wide: false },
		];
		const body = renderMarkdownBody(this.content.body, width, this.activeTheme).map((text) => ({ text, wide: false }));
		const labels = this.content.labels.length > 0
			? [{ text: "", wide: false }, ...wrap("Labels:", "muted"), ...wrap(this.content.labels.join(", "))]
			: [];
		const metadata = this.content.metadata.length > 0
			? [{ text: "", wide: false }, ...wrap("Metadata:", "muted"), ...this.content.metadata.flatMap((line) => wrap(`  ${line}`, "dim"))]
			: [];
		const relationships = this.content.relationships.length > 0
			? [
				{ text: "", wide: false },
				...wrap("Relationships:", "muted"),
				...this.content.relationships.map((text) => ({ text: theme.fg("text", text), wide: true })),
			]
			: [];
		this.lines = [...identity, ...body, ...labels, ...metadata, ...relationships];
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - this.visibleLines));
	}
}

export async function showArtifactDetailView(ctx: ExtensionCommandContext, artifact: Artifact): Promise<void> {
	const output = artifactDetailsText(artifact);
	if (ctx.mode !== "tui") { ctx.ui.notify(output, "info"); return; }
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new ArtifactDetailViewport(tui, () => ctx.ui.theme ?? theme, artifact, done));
}
