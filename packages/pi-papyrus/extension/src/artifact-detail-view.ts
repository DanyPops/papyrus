import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, type DetailSection } from "malevich-tui-components";
import {
	ARTIFACT_DETAIL_HORIZONTAL_PAN_COLUMNS,
	ARTIFACT_DETAIL_MAX_VISIBLE_LINES,
	ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
	ARTIFACT_DETAIL_RESERVED_ROWS,
	type Artifact,
	type GraphRenderer,
} from "@danypops/papyrus";
import { artifactDetailContent, artifactDetailsText, type ArtifactDetailContent } from "./artifact-detail-format.ts";
import { buildArtifactRelationshipLines } from "./artifact-relationship-lines.ts";
import { BeautifulMermaidRenderer } from "./beautiful-mermaid-renderer.ts";
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
		relationshipLines: string[],
		private readonly close: () => void,
	) {
		this.visibleLines = Math.max(
			ARTIFACT_DETAIL_MIN_VISIBLE_LINES,
			Math.min(ARTIFACT_DETAIL_MAX_VISIBLE_LINES, tui.terminal.rows - ARTIFACT_DETAIL_RESERVED_ROWS),
		);
		this.content = artifactDetailContent(artifact, relationshipLines);
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

		// Labels + Metadata are plain field/flat-line shapes -- delegated to malevich's
		// buildDetailLines. The body (markdown-rendered) and relationships (horizontally
		// pannable "wide" lines) stay hand-rolled: buildDetailLines has no concept of
		// either, and forcing them through it would either drop markdown formatting or
		// lose the pan feature.
		const fields: DetailField[] = this.content.labels.length > 0 ? [{ label: "Labels", value: this.content.labels.join(", ") }] : [];
		const sections: DetailSection[] = this.content.metadata.length > 0
			? [{ heading: "Metadata:", lines: this.content.metadata.map((line) => `  ${line}`) }]
			: [];
		const labelsAndMetadata = (fields.length > 0 || sections.length > 0)
			? buildDetailLines(width, {
				fields,
				sections,
				theme: {
					field: (s) => theme.fg("muted", s),
					heading: (s) => theme.fg("muted", s),
					byline: (s) => theme.fg("dim", s),
					body: (s) => theme.fg("text", s),
					line: (s) => theme.fg("dim", s),
				},
			}).map((text) => ({ text, wide: false }))
			: [];
		// buildDetailLines' fields/sections don't insert a leading blank before the
		// first field the way the original hand-rolled labels block did -- add it back
		// when either piece rendered anything, matching the original layout exactly.
		const labelsAndMetadataWithLeadingBlank = fields.length > 0 ? [{ text: "", wide: false }, ...labelsAndMetadata] : labelsAndMetadata;

		const relationships = this.content.relationships.length > 0
			? [
				{ text: "", wide: false },
				...wrap("Relationships:", "muted"),
				...this.content.relationships.map((text) => ({ text: theme.fg("text", text), wide: true })),
			]
			: [];
		this.lines = [...identity, ...body, ...labelsAndMetadataWithLeadingBlank, ...relationships];
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - this.visibleLines));
	}
}

export async function showArtifactDetailView(
	ctx: ExtensionCommandContext,
	artifact: Artifact,
	renderer: GraphRenderer = new BeautifulMermaidRenderer(),
): Promise<void> {
	const relationshipLines = buildArtifactRelationshipLines(artifact, renderer);
	const output = artifactDetailsText(artifact, relationshipLines);
	if (ctx.mode !== "tui") { ctx.ui.notify(output, "info"); return; }
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new ArtifactDetailViewport(tui, () => ctx.ui.theme ?? theme, artifact, relationshipLines, done));
}
