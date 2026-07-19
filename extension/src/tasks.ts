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
import type { TaskHistoryPage } from "../../src/domain/task-event.ts";
import { projectTaskExecution } from "../../src/task-execution.ts";
import type { TaskCompletion, TaskGraph, TaskStatus } from "../../src/task-service.ts";
import { TASK_STATUS_PRESENTATION, taskTreeConnector } from "./task-presentation.ts";

const STATUS_ACTIONS: Record<string, string[]> = {
	todo: ["Start", "Cancel"],
	"in-progress": ["Submit for review", "Cancel"],
	review: ["Complete review", "Reject", "Cancel"],
	rejected: ["Retry", "Cancel"],
	done: [],
	canceled: [],
};

type TaskRow = Artifact;

export interface TaskHierarchyRow {
	task: TaskRow;
	depth: number;
	childCount: number;
	dependencies: string[];
	active: boolean;
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
		result.push({ task: node.task, depth, childCount: children.length, dependencies: [...node.dependencyIds], active: node.active === true });
		for (const childId of children) visit(childId, depth + 1);
	};
	for (const rootId of graph.rootIds) visit(rootId, 0);
	for (const node of graph.nodes) visit(node.task.id, 0);
	return result;
}

async function loadTaskGraph(projectRoot: string, scope?: "project" | "graph" | "all", rootTaskId?: string): Promise<TaskGraph> {
	return callService<Record<string, unknown>, TaskGraph>("tasks.graph", {
		limit: 200,
		project_root: projectRoot,
		...(scope ? { scope } : {}),
		...(rootTaskId ? { root_task_id: rootTaskId } : {}),
	});
}

export async function showTasks(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/tasks requires interactive mode", "warning");
		return;
	}
	let graph = await loadTaskGraph(ctx.cwd);
	if (graph.nodes.length === 0) {
		const create = await ctx.ui.select("No tasks yet", ["Create a task", "Cancel"]);
		if (create === "Create a task") {
			const title = await ctx.ui.input("Task title:", "");
			if (title) {
				await callService("tasks.create", { title, project_root: ctx.cwd, actor: "user", source: "tasks-tui" });
				graph = await loadTaskGraph(ctx.cwd);
			}
		}
		if (graph.nodes.length === 0) return;
	}

	for (;;) {
		const action = await renderPanel(ctx, graph);
		if (!action) return;
		if (action.type === "refresh") { graph = await loadTaskGraph(ctx.cwd); continue; }
		if (action.type === "scope") {
			const choice = await ctx.ui.select("Task scope", ["Current project", "Focused graph", "All projects"]);
			if (!choice) continue;
			const scope: "project" | "graph" | "all" = choice === "Current project" ? "project" : choice === "All projects" ? "all" : "graph";
			let rootTaskId: string | undefined;
			if (scope === "graph") {
				const projectGraph = await loadTaskGraph(ctx.cwd, "project");
				const roots = projectGraph.rootIds.map((id) => projectGraph.nodes.find((node) => node.task.id === id)?.task).filter((task): task is Artifact => task !== undefined);
				const selected = await ctx.ui.select("Focused root or epic", roots.map((task) => `${task.title} · ${task.id}`));
				if (!selected) continue;
				rootTaskId = roots.find((task) => `${task.title} · ${task.id}` === selected)?.id;
				if (!rootTaskId) continue;
			}
			await callService("tasks.set_scope", { project_root: ctx.cwd, scope, ...(rootTaskId ? { root_task_id: rootTaskId } : {}) });
			graph = await loadTaskGraph(ctx.cwd);
			continue;
		}
		if (action.type === "graph") { await showTaskGraph(ctx, graph); continue; }
		if (action.type !== "action" || !action.row) continue;

		const active = graph.nodes.find((node) => node.task.id === action.row!.id)?.active === true;
		const focusStatus = graph.nodes.find((node) => node.task.id === action.row!.id)?.focusStatus;
		const choices = [
			"Show details",
			"Edit task",
			...(!active && action.row.status !== "done" && action.row.status !== "canceled" ? ["Make active"] : []),
			...(active ? [focusStatus === "paused" ? "Resume focus" : "Pause focus", "Clear focus"] : []),
			...(action.row.status === "review" ? ["Run gates"] : []),
			...(STATUS_ACTIONS[action.row.status] ?? []),
		];
		const choice = await ctx.ui.select(action.row.title, choices);
		if (!choice) continue;

		if (choice === "Show details") {
			const art = await callService<Record<string, unknown>, Artifact | null>("tasks.show", { id: action.row.id });
			if (!art) { ctx.ui.notify("Not found", "error"); continue; }
			const history = await callService<Record<string, unknown>, TaskHistoryPage>("tasks.history", { id: art.id, direction: "desc" });
			await showTaskDetails(ctx, art, graph, undefined, [...history.events].reverse());
		} else if (choice === "Edit task") {
			const title = await ctx.ui.input("Task title:", action.row.title);
			if (title === undefined) continue;
			const body = await ctx.ui.input("Task body:", action.row.body);
			if (body === undefined) continue;
			try {
				const updated = await callService<Record<string, unknown>, Artifact>("tasks.update", {
					id: action.row.id,
					title,
					body,
					actor: "user",
					source: "tasks-tui",
				});
				action.row.title = updated.title;
				action.row.body = updated.body;
				ctx.ui.notify(`Updated: ${updated.title}`, "info");
			} catch (error) {
				ctx.ui.notify(`Task update failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else if (choice === "Make active") {
			try {
				await callService<Record<string, unknown>, Artifact>("tasks.focus", { id: action.row.id, actor: "user", source: "tasks-tui" });
				ctx.ui.notify(`Active: ${action.row.title}`, "info");
			} catch (error) {
				ctx.ui.notify(`Focus failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else if (choice === "Pause focus" || choice === "Resume focus" || choice === "Clear focus") {
			try {
				const operation = choice === "Pause focus" ? "tasks.pause" : choice === "Resume focus" ? "tasks.unpause" : "tasks.clear_focus";
				await callService(operation, { actor: "user", source: "tasks-tui" });
				ctx.ui.notify(choice === "Clear focus" ? "Task focus cleared" : choice, "info");
			} catch (error) {
				ctx.ui.notify(`Focus action failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else if (choice === "Run gates") {
			try {
				const results = await callService<Record<string, unknown>, GateResult[]>("tasks.run_gates", { id: action.row.id, actor: "user", source: "tasks-tui" });
				ctx.ui.notify(`Gates:\n${results.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n")}`, "info");
			} catch (error) {
				ctx.ui.notify(`Gates failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else {
			try {
				const operation = choice === "Start"
					? "tasks.start"
					: choice === "Submit for review"
						? "tasks.submit"
						: choice === "Reject"
							? "tasks.reject"
							: choice === "Retry"
								? "tasks.retry"
								: choice === "Cancel"
									? "tasks.cancel"
									: "tasks.complete";
				if (operation === "tasks.complete") {
					const result = await callService<Record<string, unknown>, TaskCompletion>(operation, { id: action.row.id, actor: "user", source: "tasks-tui" });
					action.row.status = result.artifact.status;
					const gates = result.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target}`).join("\n");
					const checklist = result.checklist.map((item) => `${item.accepted ? "✓" : "✗"} proof: ${item.item}`).join("\n");
					const focused = result.focused ? `\nActive: ${result.focused.title}` : "";
					const blocked = result.blocked.length > 0
						? `\nWaiting: ${result.blocked.map((entry) => `${entry.artifact.title} needs ${entry.dependencyIds.join(", ")}`).join("; ")}`
						: "";
					ctx.ui.notify(
						result.completed
							? `Completed ${result.artifact.id}${focused}${blocked}${checklist ? `\n${checklist}` : ""}${gates ? `\n${gates}` : ""}`
							: `Review rejected${checklist ? `\n${checklist}` : ""}${gates ? `\n${gates}` : ""}`,
						result.completed ? "info" : "warning",
					);
				} else {
					const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: action.row.id, actor: "user", source: "tasks-tui" });
					action.row.status = updated.status;
					ctx.ui.notify(`${updated.id} → [${updated.status}]`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Task action failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		}
		graph = await loadTaskGraph(ctx.cwd);
	}
}

interface PanelAction {
	type: "action" | "refresh" | "graph" | "scope";
	row?: TaskRow;
}

function renderPanel(ctx: ExtensionCommandContext, graph: TaskGraph): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, theme, _kb, done) => {
		const rows = graph.nodes.map((node) => node.task);
		const searchInput = new Input();
		const hierarchy = buildTaskHierarchy(graph);
		const taskById = new Map(rows.map((task) => [task.id, task]));
		const executionById = new Map(projectTaskExecution(graph).nodes.map((node) => [node.id, node]));
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
			for (const entry of hierarchy) counts[entry.task.status] = (counts[entry.task.status] ?? 0) + 1;
			const parts = hierarchy.some((entry) => entry.active) ? ["▶ 1 active"] : [];
			for (const status of ["todo", "in-progress", "review", "rejected", "done", "canceled"] as TaskStatus[]) {
				if ((counts[status] ?? 0) > 0) {
					const presentation = TASK_STATUS_PRESENTATION[status];
					parts.push(`${presentation.glyph} ${counts[status]} ${presentation.label}`);
				}
			}
			return parts.join(", ");
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
				const title = theme.bold(`Tasks · ${graph.scope?.label ?? "scope unavailable"}`);
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
						rawKeyHint("s", "scope") +
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
					const focus = entry.active ? theme.fg("accent", "▶") : " ";
					const execution = executionById.get(row.id);
					const state = execution?.state ?? row.status;
					const presentation = TASK_STATUS_PRESENTATION[row.status as TaskStatus];
					const glyphStyled = state === "invalid"
						? theme.fg("error", "!")
						: presentation
							? theme.fg(presentation.color, presentation.glyph)
							: theme.fg("muted", "?");
					const title = selected ? theme.bold(row.title) : row.title;
					let laterSibling = false;
					for (let candidate = i + 1; candidate < filtered.length; candidate++) {
						if (filtered[candidate]!.depth < entry.depth) break;
						if (filtered[candidate]!.depth === entry.depth) { laterSibling = true; break; }
					}
					const connector = taskTreeConnector({
						depth: entry.depth,
						hasChildren: entry.childCount > 0,
						hasLaterSibling: laterSibling,
					});
					const node = entry.depth === 0 && entry.childCount > 0
						? theme.fg("accent", connector)
						: theme.fg("dim", connector);
					const gates = (row.extra?.["gates"] as any[])?.length;
					const relationParts: string[] = [];
					if (execution) relationParts.push(execution.layer === null ? state : `layer ${execution.layer + 1} · ${state}`);
					if (entry.childCount > 0) relationParts.push(`${entry.childCount} subtask${entry.childCount === 1 ? "" : "s"}`);
					if (entry.dependencies.length > 0) {
						const names = entry.dependencies.map((id) => taskById.get(id)?.title ?? id);
						relationParts.push(`needs ${names.join(", ")}`);
					}
					if (gates) relationParts.push(`${gates} gate${gates === 1 ? "" : "s"}`);
					const relationText = relationParts.length > 0 ? theme.fg("dim", ` · ${relationParts.join(" · ")}`) : "";
					lines.push(truncateToWidth(`${cursor}${focus} ${node} ${glyphStyled} ${title}${relationText}`, width, ""));
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
				else if (data === "s") { done({ type: "scope" }); return; }
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
