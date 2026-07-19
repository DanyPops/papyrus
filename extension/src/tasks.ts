/**
 * tasks.ts — /tasks interactive panel.
 * Filterable list with status glyphs, advance status, run gates, show edges.
 * Follows the pi-extension-manager / pi-packed TUI idiom.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { callService } from "./service-client.ts";
import { showTaskDetails } from "./task-detail-view.ts";
import { showTaskGraph } from "./task-graph.ts";

export { taskDetailsText } from "./task-detail-format.ts";
export { showTaskDetails } from "./task-detail-view.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { GateResult } from "../../src/domain/gate.ts";
import type { TaskGraph } from "../../src/task-service.ts";

const GLYPHS: Record<string, string> = {
	pending: "○",
	active: "●",
	done: "■",
	failed: "▲",
};

const STATUS_ACTIONS: Record<string, string[]> = {
	pending: ["Start", "Fail"],
	active: ["Complete (run gates)", "Fail"],
	done: [],
	failed: ["Retry"],
};

type TaskRow = Artifact;

export interface TaskHierarchyRow {
	task: TaskRow;
	depth: number;
	childCount: number;
	dependencies: string[];
}

export function buildTaskHierarchy(graph: TaskGraph): TaskHierarchyRow[] {
	const byId = new Map(graph.nodes.map((node) => [node.task.id, node]));
	const result: TaskHierarchyRow[] = [];
	const visited = new Set<string>();
	const visit = (id: string, depth: number): void => {
		if (visited.has(id)) return;
		const node = byId.get(id);
		if (!node) return;
		visited.add(id);
		const children = node.childIds.filter((childId) => byId.has(childId));
		result.push({ task: node.task, depth, childCount: children.length, dependencies: [...node.dependencyIds] });
		for (const childId of children) visit(childId, depth + 1);
	};
	for (const rootId of graph.rootIds) visit(rootId, 0);
	for (const node of graph.nodes) visit(node.task.id, 0);
	return result;
}

async function loadTaskGraph(): Promise<TaskGraph> {
	return callService<Record<string, unknown>, TaskGraph>("tasks.graph", { limit: 200 });
}

export async function showTasks(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/tasks requires interactive mode", "warning");
		return;
	}
	let graph = await loadTaskGraph();
	if (graph.nodes.length === 0) {
		const create = await ctx.ui.select("No tasks yet", ["Create a task", "Cancel"]);
		if (create === "Create a task") {
			const title = await ctx.ui.input("Task title:", "");
			if (title) {
				await callService("tasks.create", { title });
				graph = await loadTaskGraph();
			}
		}
		if (graph.nodes.length === 0) return;
	}

	for (;;) {
		const action = await renderPanel(ctx, graph);
		if (!action) return;
		if (action.type === "refresh") { graph = await loadTaskGraph(); continue; }
		if (action.type === "graph") { await showTaskGraph(ctx, graph); continue; }
		if (action.type !== "action" || !action.row) continue;

		const choices = ["Show details", "Run gates", ...(STATUS_ACTIONS[action.row.status] ?? [])];
		const choice = await ctx.ui.select(action.row.title, choices);
		if (!choice) continue;

		if (choice === "Show details") {
			const art = await callService<Record<string, unknown>, Artifact | null>("tasks.show", { id: action.row.id });
			if (!art) { ctx.ui.notify("Not found", "error"); continue; }
			await showTaskDetails(ctx, art, graph);
		} else if (choice === "Run gates") {
			try {
				const results = await callService<Record<string, unknown>, GateResult[]>("tasks.run_gates", { id: action.row.id });
				ctx.ui.notify(`Gates:\n${results.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n")}`, "info");
			} catch (error) {
				ctx.ui.notify(`Gates failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else {
			try {
				const operation = choice === "Start" ? "tasks.start" : choice === "Fail" ? "tasks.fail" : choice === "Retry" ? "tasks.retry" : "tasks.complete";
				if (operation === "tasks.complete") {
					const result = await callService<Record<string, unknown>, { artifact: Artifact; gates: GateResult[]; completed: boolean }>(operation, { id: action.row.id });
					action.row.status = result.artifact.status;
					const gates = result.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target}`).join("\n");
					ctx.ui.notify(result.completed ? `Completed ${result.artifact.id}${gates ? `\n${gates}` : ""}` : `Not complete; gates failed\n${gates}`, result.completed ? "info" : "warning");
				} else {
					const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: action.row.id });
					action.row.status = updated.status;
					ctx.ui.notify(`${updated.id} → [${updated.status}]`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Task action failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		}
		graph = await loadTaskGraph();
	}
}

interface PanelAction {
	type: "action" | "refresh" | "graph";
	row?: TaskRow;
}

function renderPanel(ctx: ExtensionCommandContext, graph: TaskGraph): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, theme, _kb, done) => {
		const rows = graph.nodes.map((node) => node.task);
		const searchInput = new Input();
		const hierarchy = buildTaskHierarchy(graph);
		const taskById = new Map(rows.map((task) => [task.id, task]));
		let searchActive = false;
		let filtered = [...hierarchy];
		let selectedIndex = 0;
		const maxVisible = 20;

		function applyFilter(): void {
			const q = searchInput.getValue().trim().toLowerCase();
			filtered = q ? hierarchy.filter(({ task }) =>
				task.title.toLowerCase().includes(q) || task.id.toLowerCase().includes(q)
			) : [...hierarchy];
			selectedIndex = 0;
		}

		function statusLine(): string {
			const counts: Record<string, number> = {};
			for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
			return ["pending", "active", "done", "failed"]
				.filter((s) => (counts[s] ?? 0) > 0)
				.map((s) => `${GLYPHS[s] ?? s} ${counts[s]} ${s}`)
				.join(", ");
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
				const title = theme.bold("Tasks");
				const hint = searchActive
					? rawKeyHint("esc", "clear")
					: rawKeyHint("↑/↓", "navigate") +
						theme.fg("muted", " · ") +
						rawKeyHint("enter", "actions") +
						theme.fg("muted", " · ") +
						rawKeyHint("/", "filter") +
						theme.fg("muted", " · ") +
						rawKeyHint("g", "graph") +
						theme.fg("muted", " · ") +
						rawKeyHint("r", "refresh") +
						theme.fg("muted", " · ") +
						rawKeyHint("esc", "close");
				const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
				const line1 = truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, "");
				const line2 = truncateToWidth(theme.fg("muted", statusLine()), width, "");
				return [line1, line2];
			},
		};

		const list = {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				if (searchActive) lines.push(...searchInput.render(width));
				lines.push("");
				if (filtered.length === 0) {
					lines.push(theme.fg("muted", "  No tasks"));
					return lines;
				}
				const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
				const end = Math.min(start + maxVisible, filtered.length);
				for (let i = start; i < end; i++) {
					const entry = filtered[i]!;
					const row = entry.task;
					const selected = i === selectedIndex;
					const cursor = selected ? theme.fg("accent", "❯") : " ";
					const glyph = GLYPHS[row.status] ?? "?";
					const statusColor = row.status === "active" ? "accent" : row.status === "done" ? "dim" : row.status === "failed" ? "warning" : "muted";
					const glyphStyled = theme.fg(statusColor, glyph);
					const title = selected ? theme.bold(row.title) : row.title;
					const indent = "  ".repeat(entry.depth);
					const node = entry.childCount > 0 ? theme.fg("accent", "▾") : theme.fg("dim", "·");
					const gates = (row.extra?.["gates"] as any[])?.length;
					const relationParts: string[] = [];
					if (entry.childCount > 0) relationParts.push(`${entry.childCount} subtask${entry.childCount === 1 ? "" : "s"}`);
					if (entry.dependencies.length > 0) {
						const names = entry.dependencies.map((id) => taskById.get(id)?.title ?? id);
						relationParts.push(`needs ${names.join(", ")}`);
					}
					if (gates) relationParts.push(`${gates} gate${gates === 1 ? "" : "s"}`);
					const relationText = relationParts.length > 0 ? theme.fg("dim", ` · ${relationParts.join(" · ")}`) : "";
					lines.push(truncateToWidth(`${cursor} ${indent}${node} ${glyphStyled} ${title}${relationText}`, width, ""));
				}
				const hasScroll = start > 0 || end < filtered.length;
				lines.push(theme.fg("muted", `  ${hasScroll ? `${selectedIndex + 1}/${filtered.length} · ` : ""}↑/↓ navigate · Enter actions`));
				return lines;
			},
		};

		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());
		container.addChild(new Spacer(1));
		container.addChild(header);
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (searchActive) {
					if (matchesKey(data, "escape")) { searchActive = false; applyFilter(); }
					else if (matchesKey(data, "enter")) { searchActive = false; }
					else { searchInput.handleInput(data); applyFilter(); }
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "up")) selectedIndex = (selectedIndex - 1 + filtered.length) % Math.max(filtered.length, 1);
				else if (matchesKey(data, "down")) selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1);
				else if (data === "/") searchActive = true;
				else if (data === "g") { done({ type: "graph" }); return; }
				else if (data === "r") { done({ type: "refresh" }); return; }
				else if (matchesKey(data, "enter")) {
					const entry = filtered[selectedIndex];
					if (entry) done({ type: "action", row: entry.task });
					return;
				} else if (matchesKey(data, "escape")) { done(undefined); return; }
				else return;
				tui.requestRender();
			},
		};
	});
}
