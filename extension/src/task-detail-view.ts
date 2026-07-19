import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import {
	TASK_DETAIL_HORIZONTAL_PAN_COLUMNS,
	TASK_DETAIL_MAX_VISIBLE_LINES,
	TASK_DETAIL_MIN_VISIBLE_LINES,
	TASK_DETAIL_RESERVED_ROWS,
} from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { TaskEvent } from "../../src/domain/task-event.ts";
import type { GraphRenderer } from "../../src/ports/graph-renderer.ts";
import { projectTaskRelationships } from "../../src/task-relationship-view.ts";
import type { TaskGraph } from "../../src/task-service.ts";
import { BeautifulMermaidRenderer } from "./beautiful-mermaid-renderer.ts";
import { taskDetailsText } from "./task-detail-format.ts";

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
	private readonly narrative: string;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		task: Artifact,
		private readonly graphLines: string[],
		history: TaskEvent[],
		private readonly close: () => void,
	) {
		this.visibleLines = Math.max(
			TASK_DETAIL_MIN_VISIBLE_LINES,
			Math.min(TASK_DETAIL_MAX_VISIBLE_LINES, tui.terminal.rows - TASK_DETAIL_RESERVED_ROWS),
		);
		this.narrative = taskDetailsText({ ...task, edges: undefined }, [], history);
	}

	invalidate(): void { this.renderedWidth = 0; }

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		this.buildLines(contentWidth);
		const graphWidth = this.graphLines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
		this.offsetX = Math.min(this.offsetX, Math.max(0, graphWidth - contentWidth));
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.detailLines.length - this.visibleLines));
		const end = Math.min(this.detailLines.length, this.offsetY + this.visibleLines);
		const border = this.theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const footer = [
			graphWidth > contentWidth ? `←/→ graph · column ${this.offsetX + 1}/${graphWidth}` : "",
			this.detailLines.length > this.visibleLines ? `↑/↓ scroll · ${this.offsetY + 1}-${end}/${this.detailLines.length}` : "",
			"Esc back",
		].filter(Boolean).join(" · ");
		return [
			border,
			truncateToWidth(this.theme.bold("Task details"), width, ""),
			border,
			...this.detailLines.slice(this.offsetY, end).map((line) => line.graph
				? ` ${sliceByColumn(line.text, this.offsetX, contentWidth, true)}`
				: truncateToWidth(` ${line.text}`, width, "")),
			truncateToWidth(this.theme.fg("dim", footer), width, ""),
			border,
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.close(); return; }
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
		const narrative = this.narrative.split("\n").flatMap((line) =>
			(line.length === 0 ? [""] : wrapTextWithAnsi(line, width)).map((text) => ({ text, graph: false })));
		const relationshipHeader = this.graphLines.length > 0
			? [
				{ text: "", graph: false },
				{ text: "Relationships:", graph: false },
				{ text: "  Dependencies point prerequisite → dependent.", graph: false },
			]
			: [];
		this.detailLines = [...narrative, ...relationshipHeader, ...this.graphLines.map((text) => ({ text, graph: true }))];
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
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new TaskDetailViewport(tui, theme, task, relationshipGraph, history, done));
}
