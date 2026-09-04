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
import { buildDetailLines, type DetailField, type DetailSection, type TextMeasure } from "malevich-tui-components";
import { BeautifulMermaidRenderer } from "../beautiful-mermaid-renderer.ts";
import { type ActiveTheme, renderMarkdownBody } from "../markdown.ts";
import { type TaskDetailContent, taskDetailContent, taskDetailsText } from "./task-detail-format.ts";
import { TASK_STATUS_PRESENTATION } from "./task-presentation.ts";

/** Real ANSI-aware measure for buildDetailLines -- without it, wrapped themed text loses color on every line but the first/last. */
const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

interface DetailLine {
	text: string;
	graph: boolean;
}

class TaskDetailViewport {
	private offsetX = 0;
	private compactOffsetY = 0;
	private expandedOffsetY = 0;
	private expandedOffsetInitialized = false;
	private renderedWidth = 0;
	private detailLines: DetailLine[] = [];
	private readonly compactVisibleLines: number;
	private readonly content: TaskDetailContent;
	private expanded = false;
	private readonly status: Artifact["status"];

	constructor(
		private readonly tui: TUI,
		private readonly activeTheme: ActiveTheme,
		task: Artifact,
		private readonly graphLines: string[],
		history: TaskEvent[],
		private readonly close: () => void,
		private readonly matchesBinding: (data: string, binding: "up" | "down" | "pageUp" | "pageDown" | "cancel") => boolean,
	) {
		this.compactVisibleLines = Math.max(
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
		const visibleLines = this.visibleLineCount();
		const offsetY = Math.min(this.activeOffsetY(), Math.max(0, this.detailLines.length - visibleLines));
		const end = Math.min(this.detailLines.length, offsetY + visibleLines);
		const theme = this.activeTheme();
		const border = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const footer = [
			graphWidth > contentWidth ? `←/→ graph · column ${this.offsetX + 1}/${graphWidth}` : "",
			this.detailLines.length > visibleLines ? `j/k scroll · ${offsetY + 1}-${end}/${this.detailLines.length}` : "",
			`f ${this.expanded ? "compact" : "expand"}`,
			"q/Esc back",
		]
			.filter(Boolean)
			.join(" · ");
		return [
			border,
			truncateToWidth(theme.fg("accent", theme.bold("Task details")), width, ""),
			border,
			...this.detailLines
				.slice(offsetY, end)
				.map((line) =>
					line.graph ? ` ${sliceByColumn(line.text, this.offsetX, contentWidth, true)}` : truncateToWidth(` ${line.text}`, width, ""),
				),
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
		const offsetY = Math.min(this.activeOffsetY(), Math.max(0, this.detailLines.length - visibleLines));
		if (this.matchesBinding(data, "up") || data === "k") this.setActiveOffsetY(Math.max(0, offsetY - 1));
		else if (this.matchesBinding(data, "down") || data === "j")
			this.setActiveOffsetY(Math.min(Math.max(0, this.detailLines.length - visibleLines), offsetY + 1));
		else if (this.matchesBinding(data, "pageUp") || matchesKey(data, "ctrl+u"))
			this.setActiveOffsetY(Math.max(0, offsetY - Math.max(1, Math.floor(visibleLines / 2))));
		else if (this.matchesBinding(data, "pageDown") || matchesKey(data, "ctrl+d"))
			this.setActiveOffsetY(
				Math.min(Math.max(0, this.detailLines.length - visibleLines), offsetY + Math.max(1, Math.floor(visibleLines / 2))),
			);
		else if (matchesKey(data, "left") || data === "h") this.offsetX = Math.max(0, this.offsetX - TASK_DETAIL_HORIZONTAL_PAN_COLUMNS);
		else if (matchesKey(data, "right") || data === "l") this.offsetX += TASK_DETAIL_HORIZONTAL_PAN_COLUMNS;
		else if (data === "g") this.setActiveOffsetY(0);
		else if (data === "G") this.setActiveOffsetY(Math.max(0, this.detailLines.length - visibleLines));
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
			? Math.max(this.compactVisibleLines, this.tui.terminal.rows - TASK_DETAIL_RESERVED_ROWS)
			: this.compactVisibleLines;
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
				? [
						...buildDetailLines(width, { fields, theme: detailTheme, measure }).map((text) => ({ text, graph: false })),
						{ text: "", graph: false },
					]
				: [{ text: "", graph: false }];
		const body = renderMarkdownBody(this.content.body, width, this.activeTheme).map((text) => ({ text, graph: false }));
		const sections: DetailSection[] = this.content.sections.map((section) => ({ heading: section[0], lines: section.slice(1) }));
		const sectionLines =
			sections.length > 0 ? buildDetailLines(width, { sections, theme: detailTheme, measure }).map((text) => ({ text, graph: false })) : [];
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
		(tui, theme, keybindings, done) =>
			new TaskDetailViewport(
				tui,
				() => ctx.ui.theme ?? theme,
				task,
				relationshipGraph,
				history,
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
