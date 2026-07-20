import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import {
	ARTIFACT_DETAIL_HORIZONTAL_PAN_COLUMNS,
	ARTIFACT_DETAIL_MAX_VISIBLE_LINES,
	ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
	ARTIFACT_DETAIL_RESERVED_ROWS,
} from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import { artifactDetailsText } from "./artifact-detail-format.ts";

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
	private readonly narrative: string;
	private readonly relationships: string[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		artifact: Artifact,
		private readonly close: () => void,
	) {
		this.visibleLines = Math.max(
			ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
			Math.min(ARTIFACT_DETAIL_MAX_VISIBLE_LINES, tui.terminal.rows - ARTIFACT_DETAIL_RESERVED_ROWS),
		);
		this.narrative = artifactDetailsText({ ...artifact, edges: undefined });
		this.relationships = (artifact.edges ?? []).map((edge) => `${edge.from} --${edge.relation}--> ${edge.to}`);
	}

	invalidate(): void { this.renderedWidth = 0; }

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		this.buildLines(contentWidth);
		const wideWidth = this.relationships.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
		this.offsetX = Math.min(this.offsetX, Math.max(0, wideWidth - contentWidth));
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - this.visibleLines));
		const end = Math.min(this.lines.length, this.offsetY + this.visibleLines);
		const border = this.theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const footer = [
			wideWidth > contentWidth ? `←/→ relationships · column ${this.offsetX + 1}/${wideWidth}` : "",
			this.lines.length > this.visibleLines ? `↑/↓ scroll · ${this.offsetY + 1}-${end}/${this.lines.length}` : "",
			"Esc back",
		].filter(Boolean).join(" · ");
		return [
			border,
			truncateToWidth(this.theme.bold("Artifact details"), width, ""),
			border,
			...this.lines.slice(this.offsetY, end).map((line) => line.wide
				? ` ${sliceByColumn(line.text, this.offsetX, contentWidth, true)}`
				: truncateToWidth(` ${line.text}`, width, "")),
			truncateToWidth(this.theme.fg("dim", footer), width, ""),
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
		const narrative = this.narrative.split("\n").flatMap((line) =>
			(line.length === 0 ? [""] : wrapTextWithAnsi(line, width)).map((text) => ({ text, wide: false })));
		const relationshipSection = this.relationships.length > 0
			? [{ text: "", wide: false }, { text: "Relationships:", wide: false }, ...this.relationships.map((text) => ({ text, wide: true }))]
			: [];
		this.lines = [...narrative, ...relationshipSection];
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - this.visibleLines));
	}
}

export async function showArtifactDetailView(ctx: ExtensionCommandContext, artifact: Artifact): Promise<void> {
	const output = artifactDetailsText(artifact);
	if (ctx.mode !== "tui") { ctx.ui.notify(output, "info"); return; }
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new ArtifactDetailViewport(tui, theme, artifact, done));
}
