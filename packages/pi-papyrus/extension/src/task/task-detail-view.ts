import {
	type Artifact,
	type GraphRenderer,
	projectTaskRelationships,
	TASK_DETAIL_HORIZONTAL_PAN_COLUMNS,
	TASK_DETAIL_MAX_VISIBLE_LINES,
	TASK_DETAIL_MIN_VISIBLE_LINES,
	TASK_DETAIL_RESERVED_ROWS,
	type TaskEvent,
	type TaskGraph,
} from "@danypops/papyrus";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, type DetailSection } from "malevich-tui-components";
import { BeautifulMermaidRenderer } from "../beautiful-mermaid-renderer.ts";
import { type ActiveTheme, renderMarkdownBody } from "../markdown.ts";
import { type TaskDetailContent, taskDetailContent, taskDetailsText } from "./task-detail-format.ts";
import { TASK_STATUS_PRESENTATION } from "./task-presentation.ts";

interface DetailLine {
	text: string;
	graph: boolean;
}

class TaskDetailViewport {
	private offsetX = 0;
	private offsetY = 0;
	private renderedWidth = 0;
	private detailLines: DetailLine[] = [];
	private readonly visibleLines: number;
	private readonly content: TaskDetailContent;
	private readonly status: Artifact["status"];

	constructor(
		private readonly tui: TUI,
		private readonly activeTheme: ActiveTheme,
		task: Artifact,
		private readonly graphLines: string[],
		history: TaskEvent[],
		private readonly close: () => void,
	) {
		this.visibleLines = Math.max(
			TASK_DETAIL_MIN_VISIBLE_LINES,
			Math.min(TASK_DETAIL_MAX_VISIBLE_LINES, tui.terminal.rows - TASK_DETAIL_RESERVED_ROWS),
		);
		this.content = taskDetailContent(task, history);
		this.status = task.status;
	}

	invalidate(): void {
		this.renderedWidth = 0;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		this.buildLines(contentWidth);
		const graphWidth = this.graphLines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
		this.offsetX = Math.min(this.offsetX, Math.max(0, graphWidth - contentWidth));
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.detailLines.length - this.visibleLines));
		const end = Math.min(this.detailLines.length, this.offsetY + this.visibleLines);
		const theme = this.activeTheme();
		const border = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const footer = [
			graphWidth > contentWidth ? `←/→ graph · column ${this.offsetX + 1}/${graphWidth}` : "",
			this.detailLines.length > this.visibleLines ? `↑/↓ scroll · ${this.offsetY + 1}-${end}/${this.detailLines.length}` : "",
			"Esc back",
		]
			.filter(Boolean)
			.join(" · ");
		return [
			border,
			truncateToWidth(theme.fg("accent", theme.bold("Task details")), width, ""),
			border,
			...this.detailLines
				.slice(this.offsetY, end)
				.map((line) =>
					line.graph ? ` ${sliceByColumn(line.text, this.offsetX, contentWidth, true)}` : truncateToWidth(` ${line.text}`, width, ""),
				),
			truncateToWidth(theme.fg("dim", footer), width, ""),
			border,
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
		else if (matchesKey(data, "down")) this.offsetY = Math.min(Math.max(0, this.detailLines.length - this.visibleLines), this.offsetY + 1);
		else if (matchesKey(data, "left")) this.offsetX = Math.max(0, this.offsetX - TASK_DETAIL_HORIZONTAL_PAN_COLUMNS);
		else if (matchesKey(data, "right")) this.offsetX += TASK_DETAIL_HORIZONTAL_PAN_COLUMNS;
		else return;
		this.tui.requestRender();
	}

	private buildLines(width: number): void {
		if (this.renderedWidth === width) return;
		this.renderedWidth = width;
		const theme = this.activeTheme();
		const wrap = (text: string, color: "text" | "muted" | "dim" = "text"): DetailLine[] =>
			(text.length === 0 ? [""] : wrapTextWithAnsi(theme.fg(color, text), width)).map((line) => ({ text: line, graph: false }));
		const status = TASK_STATUS_PRESENTATION[this.status as keyof typeof TASK_STATUS_PRESENTATION];
		const headline = status ? theme.fg(status.color, theme.bold(this.content.headline)) : theme.bold(this.content.headline);

		// Labels + the checklist/gates/metadata/history sections are plain field/flat-line
		// shapes -- delegated to malevich's buildDetailLines. The headline/identity (styled
		// per task status), body (markdown-rendered), and the relationship graph
		// (horizontally pannable "wide" lines) stay hand-rolled: buildDetailLines has no
		// concept of any of those.
		const identity = [
			...wrapTextWithAnsi(headline, width).map((text) => ({ text, graph: false })),
			...wrap(this.content.identity, "muted"),
		];
		const detailTheme = {
			field: (s: string) => theme.fg("muted", s),
			heading: (s: string) => theme.fg("muted", s),
			byline: (s: string) => theme.fg("dim", s),
			body: (s: string) => theme.fg("text", s),
			line: (s: string) => theme.fg("dim", s),
		};
		const fields: DetailField[] = this.content.labels.length > 0 ? [{ label: "Labels", value: this.content.labels.join(", ") }] : [];
		const labels =
			fields.length > 0
				? [...buildDetailLines(width, { fields, theme: detailTheme }).map((text) => ({ text, graph: false })), { text: "", graph: false }]
				: [{ text: "", graph: false }];
		const body = renderMarkdownBody(this.content.body, width, this.activeTheme).map((text) => ({ text, graph: false }));
		const sections: DetailSection[] = this.content.sections.map((section) => ({ heading: section[0], lines: section.slice(1) }));
		const sectionLines =
			sections.length > 0 ? buildDetailLines(width, { sections, theme: detailTheme }).map((text) => ({ text, graph: false })) : [];
		const relationshipHeader =
			this.graphLines.length > 0
				? [{ text: "", graph: false }, ...wrap("Relationships:", "muted"), ...wrap("  Dependencies point prerequisite → dependent.", "dim")]
				: [];
		this.detailLines = [
			...identity,
			...labels,
			...body,
			...sectionLines,
			...relationshipHeader,
			...this.graphLines.map((text) => ({ text: theme.fg("text", text), graph: true })),
		];
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.detailLines.length - this.visibleLines));
	}
}

export async function showTaskDetails(
	ctx: ExtensionCommandContext,
	task: Artifact,
	graph?: TaskGraph,
	renderer: GraphRenderer = new BeautifulMermaidRenderer(),
	history: TaskEvent[] = [],
): Promise<void> {
	const relationshipGraph = renderer.render(projectTaskRelationships(task, graph)).lines;
	const content = taskDetailsText(task, relationshipGraph, history);
	if (ctx.mode !== "tui") {
		ctx.ui.notify(content, "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new TaskDetailViewport(tui, () => ctx.ui.theme ?? theme, task, relationshipGraph, history, done),
	);
}
