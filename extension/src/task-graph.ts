import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
	TASK_GRAPH_HORIZONTAL_PAN_COLUMNS,
	TASK_GRAPH_MAX_VISIBLE_LINES,
	TASK_GRAPH_MIN_VISIBLE_LINES,
	TASK_GRAPH_RESERVED_ROWS,
} from "../../src/constants.ts";
import type { GraphRenderer } from "../../src/ports/graph-renderer.ts";
import { projectTaskGraph, type TaskGraphView } from "../../src/task-graph-view.ts";
import type { TaskGraph } from "../../src/task-service.ts";
import { BeautifulMermaidRenderer } from "./beautiful-mermaid-renderer.ts";
import { TASK_STATUS_PRESENTATION } from "./task-presentation.ts";

const GRAPH_VIEWS: TaskGraphView[] = ["execution", "dependencies", "composition"];

export function colorizeTaskGraphLine(theme: Theme, line: string): string {
	let colored = line;
	for (const presentation of Object.values(TASK_STATUS_PRESENTATION)) {
		colored = colored.replaceAll(presentation.glyph, theme.fg(presentation.color, presentation.glyph));
	}
	return colored.replaceAll("▶", theme.fg("accent", "▶"));
}

export class TaskGraphViewport {
	private viewIndex = 0;
	private offsetX = 0;
	private offsetY = 0;
	private graphLines: string[] = [];
	private readonly viewportHeight: number;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly graph: TaskGraph,
		private readonly renderer: GraphRenderer,
		private readonly close: () => void,
	) {
		this.viewportHeight = Math.max(
			TASK_GRAPH_MIN_VISIBLE_LINES,
			Math.min(TASK_GRAPH_MAX_VISIBLE_LINES, tui.terminal.rows - TASK_GRAPH_RESERVED_ROWS),
		);
		this.rebuild();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width);
		const graphWidth = this.graphLines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
		this.offsetX = Math.min(this.offsetX, Math.max(0, graphWidth - contentWidth));
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.graphLines.length - this.viewportHeight));
		const end = Math.min(this.graphLines.length, this.offsetY + this.viewportHeight);
		const border = this.theme.fg("borderMuted", "─".repeat(contentWidth));
		const position = graphWidth > contentWidth || this.graphLines.length > this.viewportHeight
			? ` · column ${this.offsetX + 1}/${Math.max(contentWidth, graphWidth)} · row ${this.offsetY + 1}/${this.graphLines.length}`
			: "";
		return [
			border,
			truncateToWidth(this.theme.bold(`Task graph · ${GRAPH_VIEWS[this.viewIndex]}`), contentWidth, ""),
			truncateToWidth(this.theme.fg("dim", `Tab switch · arrows pan · Esc back${position}`), contentWidth, ""),
			border,
			...this.graphLines.slice(this.offsetY, end).map((line) =>
				colorizeTaskGraphLine(this.theme, sliceByColumn(line, this.offsetX, contentWidth, true))),
			border,
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.close(); return; }
		if (matchesKey(data, "tab")) this.switchView();
		else if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
		else if (matchesKey(data, "down")) this.offsetY = Math.min(Math.max(0, this.graphLines.length - this.viewportHeight), this.offsetY + 1);
		else if (matchesKey(data, "left")) this.offsetX = Math.max(0, this.offsetX - TASK_GRAPH_HORIZONTAL_PAN_COLUMNS);
		else if (matchesKey(data, "right")) this.offsetX += TASK_GRAPH_HORIZONTAL_PAN_COLUMNS;
		else return;
		this.tui.requestRender();
	}

	private switchView(): void {
		this.viewIndex = (this.viewIndex + 1) % GRAPH_VIEWS.length;
		this.offsetX = 0;
		this.offsetY = 0;
		this.rebuild();
	}

	private rebuild(): void {
		const view = GRAPH_VIEWS[this.viewIndex]!;
		this.graphLines = this.renderer.render(projectTaskGraph(this.graph, view)).lines;
		if (this.graphLines.length === 0) this.graphLines = [`No task ${view} relationships`];
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.graphLines.length - this.viewportHeight));
	}
}

export async function showTaskGraph(
	ctx: ExtensionCommandContext,
	graph: TaskGraph,
	renderer: GraphRenderer = new BeautifulMermaidRenderer(),
): Promise<void> {
	if (ctx.mode !== "tui") {
		const rendered = renderer.render(projectTaskGraph(graph, "execution"));
		ctx.ui.notify(rendered.lines.join("\n") || "No tasks in the execution graph", "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new TaskGraphViewport(tui, theme, graph, renderer, done));
}
