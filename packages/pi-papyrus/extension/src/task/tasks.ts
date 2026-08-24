/**
 * tasks.ts — /tasks interactive panel.
 * Filterable list with status glyphs, advance status, run gates, show edges.
 * Follows the pi-extension-manager / pi-packed TUI idiom.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, matchesKey, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	artifactBinderPath,
	artifactSearchText,
	artifactsInBinder,
	binderSearchText,
	childBinders,
	createBinderInteractive,
	currentBinderPath,
	editBinderInteractive,
	inheritedLabelsFor,
	loadBinderTree,
	moveArtifactInteractive,
	moveBinderInteractive,
	parseLabelInput,
	removeBinderInteractive,
} from "../artifact/binder-navigation.ts";
import { callService } from "../service-client.ts";
import { sessionSecretField } from "../session-identity.ts";
import { showTaskDetails } from "./task-detail-view.ts";
import { emitTaskFocusEvent, extractDeclaredEffort } from "./task-focus-events.ts";
import { showTaskGraph } from "./task-graph.ts";

export { taskDetailsText } from "./task-detail-format.ts";
export { showTaskDetails } from "./task-detail-view.ts";

import {
	type Artifact,
	type BinderNode,
	type BinderTree,
	type GateResult,
	projectTaskExecution,
	type TaskCompletion,
	type TaskGraph,
	type TaskHistoryPage,
	type TaskStatus,
} from "@danypops/papyrus";
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

function taskChoiceLabels(tasks: readonly Artifact[]): string[] {
	const titleCounts = new Map<string, number>();
	for (const task of tasks) titleCounts.set(task.title, (titleCounts.get(task.title) ?? 0) + 1);
	return tasks.map((task) => (titleCounts.get(task.title)! > 1 ? `${task.title} (${task.id})` : task.title));
}

export interface TaskHierarchyRow {
	task: TaskRow;
	depth: number;
	childCount: number;
	dependencies: string[];
	active: boolean;
}

export function buildTaskHierarchy(graph: TaskGraph, includedIds?: ReadonlySet<string>): TaskHierarchyRow[] {
	const byId = new Map(
		graph.nodes.filter((node) => includedIds === undefined || includedIds.has(node.task.id)).map((node) => [node.task.id, node]),
	);
	const result: TaskHierarchyRow[] = [];
	const visited = new Set<string>();
	const visit = (id: string, depth: number): void => {
		if (visited.has(id)) return;
		const node = byId.get(id);
		if (!node) return;
		visited.add(id);
		const children = node.childIds.filter((childId) => byId.has(childId));
		result.push({
			task: node.task,
			depth,
			childCount: children.length,
			dependencies: [...node.dependencyIds],
			active: node.active === true,
		});
		for (const childId of children) visit(childId, depth + 1);
	};
	for (const rootId of graph.rootIds) visit(rootId, 0);
	for (const node of graph.nodes) {
		if (byId.has(node.task.id)) visit(node.task.id, 0);
	}
	return result;
}

async function loadTaskGraph(
	projectRoot: string,
	sessionId: string,
	scope?: "project" | "graph" | "all",
	rootTaskId?: string,
): Promise<TaskGraph> {
	return callService<Record<string, unknown>, TaskGraph>("tasks.graph", {
		limit: 200,
		project_root: projectRoot,
		session_id: sessionId,
		...(scope ? { scope } : {}),
		...(rootTaskId ? { root_task_id: rootTaskId } : {}),
	});
}

export async function showTasks(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/tasks requires interactive mode", "warning");
		return;
	}
	// Scopes this panel's "active"/Focus reads and writes to this Pi session, so a second
	// concurrent agent working the same project never appears as (or is overridden by) this one.
	const sessionId = ctx.sessionManager.getSessionId();
	let graph = await loadTaskGraph(ctx.cwd, sessionId);
	let binders = await loadBinderTree(
		ctx.cwd,
		graph.nodes.map((node) => node.task.id),
	);
	let currentBinderId: string | undefined;
	const refresh = async (): Promise<void> => {
		graph = await loadTaskGraph(ctx.cwd, sessionId);
		binders = await loadBinderTree(
			ctx.cwd,
			graph.nodes.map((node) => node.task.id),
		);
		if (currentBinderId && !binders.nodes.some((node) => node.binder.id === currentBinderId)) currentBinderId = undefined;
	};
	if (graph.nodes.length === 0 && binders.nodes.length === 0) {
		const create = await ctx.ui.select("No tasks or Binders yet", ["Create a task", "Create a Binder", "Cancel"]);
		if (create === "Create a task") {
			const title = await ctx.ui.input("Task title:", "");
			if (title) {
				await callService("tasks.create", { title, project_root: ctx.cwd, actor: "user", source: "tasks-tui", session_id: sessionId });
				await refresh();
			}
		} else if (create === "Create a Binder") {
			if (await createBinderInteractive(ctx, undefined)) await refresh();
		} else return;
	}

	for (;;) {
		const action = await renderPanel(ctx, graph, binders, currentBinderId);
		if (!action) return;
		if (action.type === "refresh") {
			await refresh();
			continue;
		}
		if (action.type === "navigate") {
			currentBinderId = action.binderId;
			continue;
		}
		if (action.type === "create-binder") {
			if (await createBinderInteractive(ctx, currentBinderId)) await refresh();
			continue;
		}
		if (action.type === "binder-action" && action.binder) {
			const choice = await ctx.ui.select(action.binder.path, [
				"Open",
				"Create nested Binder",
				"Rename / edit inherited labels",
				"Move Binder",
				"Remove empty Binder",
			]);
			if (!choice) continue;
			if (choice === "Open") {
				currentBinderId = action.binder.binder.id;
				continue;
			}
			let changed = false;
			if (choice === "Create nested Binder") changed = await createBinderInteractive(ctx, action.binder.binder.id);
			else if (choice === "Rename / edit inherited labels") changed = await editBinderInteractive(ctx, action.binder);
			else if (choice === "Move Binder") changed = await moveBinderInteractive(ctx, binders, action.binder);
			else if (choice === "Remove empty Binder") changed = await removeBinderInteractive(ctx, action.binder);
			if (changed) await refresh();
			continue;
		}
		if (action.type === "scope") {
			const choice = await ctx.ui.select("Task scope", ["Current project", "Focused graph", "All projects"]);
			if (!choice) continue;
			const scope: "project" | "graph" | "all" = choice === "Current project" ? "project" : choice === "All projects" ? "all" : "graph";
			let rootTaskId: string | undefined;
			if (scope === "graph") {
				const projectGraph = await loadTaskGraph(ctx.cwd, sessionId, "project");
				const roots = projectGraph.rootIds
					.map((id) => projectGraph.nodes.find((node) => node.task.id === id)?.task)
					.filter((task): task is Artifact => task !== undefined);
				const rootLabels = taskChoiceLabels(roots);
				const selected = await ctx.ui.select("Focused root or epic", rootLabels);
				if (!selected) continue;
				rootTaskId = roots[rootLabels.indexOf(selected)]?.id;
				if (!rootTaskId) continue;
			}
			await callService("tasks.set_scope", { project_root: ctx.cwd, scope, ...(rootTaskId ? { root_task_id: rootTaskId } : {}) });
			await refresh();
			continue;
		}
		if (action.type === "graph") {
			await showTaskGraph(ctx, graph);
			continue;
		}
		if (action.type !== "action" || !action.row) continue;

		const rowId = action.row.id;
		const node = graph.nodes.find((entry) => entry.task.id === rowId);
		const active = node?.active === true;
		const focusStatus = node?.focusStatus;
		const choices = [
			"Show details",
			"Edit task",
			"Move to Binder",
			...(!active && action.row.status !== "done" && action.row.status !== "canceled" ? ["Make active"] : []),
			...(active ? [focusStatus === "paused" ? "Resume focus" : "Pause focus", "Clear focus"] : []),
			...(action.row.status === "review" ? ["Run gates"] : []),
			...((node?.dependencyIds.length ?? 0) > 0 ? ["Remove dependency"] : []),
			...((node?.parentIds.length ?? 0) > 0 ? ["Remove from parent"] : []),
			...(STATUS_ACTIONS[action.row.status] ?? []),
		];
		const choice = await ctx.ui.select(action.row.title, choices);
		if (!choice) continue;
		if (choice === "Move to Binder") {
			await moveArtifactInteractive(ctx, binders, action.row);
			await refresh();
			continue;
		}

		if ((choice === "Remove dependency" || choice === "Remove from parent") && node) {
			const relatedIds = choice === "Remove dependency" ? node.dependencyIds : node.parentIds;
			const relatedTasks = relatedIds
				.map((relatedId) => graph.nodes.find((entry) => entry.task.id === relatedId)?.task)
				.filter((task): task is Artifact => task !== undefined);
			const relatedTitles = taskChoiceLabels(relatedTasks);
			const selected = await ctx.ui.select(
				choice === "Remove dependency" ? "Remove which dependency?" : "Remove from which parent?",
				relatedTitles,
			);
			if (!selected) continue;
			const relatedTask = relatedTasks[relatedTitles.indexOf(selected)];
			if (!relatedTask) continue;
			const relatedId = relatedTask.id;
			try {
				if (choice === "Remove dependency") {
					await callService("tasks.undepend", {
						id: action.row.id,
						dependency_id: relatedId,
						actor: "user",
						source: "tasks-tui",
						session_id: sessionId,
					});
					ctx.ui.notify(`Removed dependency on ${relatedTask.title}`, "info");
				} else {
					await callService("tasks.uncontain", {
						parent_id: relatedId,
						child_id: action.row.id,
						actor: "user",
						source: "tasks-tui",
						session_id: sessionId,
					});
					ctx.ui.notify(`Removed from parent ${relatedTask.title}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Relationship removal failed: ${error instanceof Error ? error.message : error}`, "error");
			}
			await refresh();
			continue;
		}

		if (choice === "Show details") {
			const art = await callService<Record<string, unknown>, Artifact | null>("tasks.show", { id: action.row.id });
			if (!art) {
				ctx.ui.notify("Not found", "error");
				continue;
			}
			const history = await callService<Record<string, unknown>, TaskHistoryPage>("tasks.history", { id: art.id, direction: "desc" });
			await showTaskDetails(ctx, art, graph, undefined, [...history.events].reverse());
		} else if (choice === "Edit task") {
			const title = await ctx.ui.input("Task title:", action.row.title);
			if (title === undefined) continue;
			const body = await ctx.ui.input("Task body:", action.row.body);
			if (body === undefined) continue;
			const labels = await ctx.ui.input("Direct labels (comma-separated):", action.row.labels.join(", "));
			if (labels === undefined) continue;
			try {
				const updated = await callService<Record<string, unknown>, Artifact>("tasks.update", {
					id: action.row.id,
					title,
					body,
					labels: parseLabelInput(labels),
					actor: "user",
					source: "tasks-tui",
				});
				action.row.title = updated.title;
				action.row.body = updated.body;
				action.row.labels = updated.labels;
				ctx.ui.notify(`Updated: ${updated.title}`, "info");
			} catch (error) {
				ctx.ui.notify(`Task update failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else if (choice === "Make active") {
			try {
				const focused = await callService<Record<string, unknown>, Artifact>("tasks.focus", {
					id: action.row.id,
					actor: "user",
					source: "tasks-tui",
					session_id: sessionId,
					...sessionSecretField(sessionId),
				});
				emitTaskFocusEvent({ taskId: focused.id, sessionId, status: "focused", effort: extractDeclaredEffort(focused.extra) });
				ctx.ui.notify(`Active: ${action.row.title}`, "info");
			} catch (error) {
				ctx.ui.notify(`Focus failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else if (choice === "Pause focus" || choice === "Resume focus" || choice === "Clear focus") {
			try {
				if (choice === "Clear focus") {
					await callService("tasks.clear_focus", {
						actor: "user",
						source: "tasks-tui",
						session_id: sessionId,
						...sessionSecretField(sessionId),
					});
					emitTaskFocusEvent({ taskId: null, sessionId, status: "cleared" });
				} else {
					const operation = choice === "Pause focus" ? "tasks.pause" : "tasks.unpause";
					const result = await callService<Record<string, unknown>, { artifact: Artifact; status: string }>(operation, {
						actor: "user",
						source: "tasks-tui",
						session_id: sessionId,
						...sessionSecretField(sessionId),
					});
					emitTaskFocusEvent({
						taskId: result.artifact.id,
						sessionId,
						status: choice === "Pause focus" ? "paused" : "unpaused",
						effort: extractDeclaredEffort(result.artifact.extra),
					});
				}
				ctx.ui.notify(choice === "Clear focus" ? "Task focus cleared" : choice, "info");
			} catch (error) {
				ctx.ui.notify(`Focus action failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else if (choice === "Run gates") {
			try {
				const results = await callService<Record<string, unknown>, GateResult[]>("tasks.run_gates", {
					id: action.row.id,
					actor: "user",
					source: "tasks-tui",
				});
				ctx.ui.notify(
					`Gates:\n${results.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n")}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Gates failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else {
			try {
				const operation =
					choice === "Start"
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
					const result = await callService<Record<string, unknown>, TaskCompletion>(operation, {
						id: action.row.id,
						actor: "user",
						source: "tasks-tui",
						session_id: sessionId,
					});
					action.row.status = result.artifact.status;
					const gates = result.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target}`).join("\n");
					const checklist = result.checklist.map((item) => `${item.accepted ? "✓" : "✗"} proof: ${item.item}`).join("\n");
					const focused = result.focused ? `\nActive: ${result.focused.title}` : "";
					const taskById = new Map(graph.nodes.map((entry) => [entry.task.id, entry.task]));
					const blocked =
						result.blocked.length > 0
							? `\nWaiting: ${result.blocked.map((entry) => `${entry.artifact.title} needs ${entry.dependencyIds.map((id) => taskById.get(id)?.title ?? "unknown task").join(", ")}`).join("; ")}`
							: "";
					ctx.ui.notify(
						result.completed
							? `Completed ${result.artifact.title}${focused}${blocked}${checklist ? `\n${checklist}` : ""}${gates ? `\n${gates}` : ""}`
							: `Review rejected${checklist ? `\n${checklist}` : ""}${gates ? `\n${gates}` : ""}`,
						result.completed ? "info" : "warning",
					);
				} else {
					const updated = await callService<Record<string, unknown>, Artifact>(operation, {
						id: action.row.id,
						actor: "user",
						source: "tasks-tui",
						session_id: sessionId,
					});
					action.row.status = updated.status;
					ctx.ui.notify(`${updated.title} → [${updated.status}]`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Task action failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		}
		await refresh();
	}
}

type TaskPanelEntry = { type: "binder"; node: BinderNode } | { type: "task"; entry: TaskHierarchyRow };

interface PanelAction {
	type: "action" | "binder-action" | "navigate" | "create-binder" | "refresh" | "graph" | "scope";
	row?: TaskRow;
	binder?: BinderNode;
	binderId?: string;
}

function renderPanel(
	ctx: ExtensionCommandContext,
	graph: TaskGraph,
	binders: BinderTree,
	currentBinderId: string | undefined,
): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, theme, _kb, done) => {
		const rows = graph.nodes.map((node) => node.task);
		const searchInput = new Input();
		const allHierarchy = buildTaskHierarchy(graph);
		const directoryIds = new Set(artifactsInBinder(rows, binders, currentBinderId).map((task) => task.id));
		const directoryHierarchy = buildTaskHierarchy(graph, directoryIds);
		const currentEntries = (): TaskPanelEntry[] => [
			...childBinders(binders, currentBinderId).map((node): TaskPanelEntry => ({ type: "binder", node })),
			...directoryHierarchy.map((entry): TaskPanelEntry => ({ type: "task", entry })),
		];
		const taskById = new Map(rows.map((task) => [task.id, task]));
		const executionById = new Map(projectTaskExecution(graph).nodes.map((node) => [node.id, node]));
		let searchActive = false;
		let filtered = currentEntries();
		let selectedIndex = 0;
		const maxVisible = 20;

		function applyFilter(): void {
			const query = searchInput.getValue().trim().toLowerCase();
			filtered = query
				? [
						...binders.nodes
							.filter((node) => binderSearchText(node).includes(query))
							.map((node): TaskPanelEntry => ({ type: "binder", node })),
						...allHierarchy
							.filter(({ task }) => artifactSearchText(task, binders).includes(query))
							.map((entry): TaskPanelEntry => ({ type: "task", entry: { ...entry, depth: 0 } })),
					].sort((left, right) => {
						const leftPath = left.type === "binder" ? left.node.path : artifactBinderPath(left.entry.task, binders);
						const rightPath = right.type === "binder" ? right.node.path : artifactBinderPath(right.entry.task, binders);
						return leftPath.localeCompare(rightPath);
					})
				: currentEntries();
			selectedIndex = 0;
		}

		function statusLine(): string {
			const counts: Record<string, number> = {};
			for (const entry of allHierarchy) counts[entry.task.status] = (counts[entry.task.status] ?? 0) + 1;
			const parts = allHierarchy.some((entry) => entry.active) ? ["▶ 1 active"] : [];
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
				const title = theme.bold(`Tasks · ${graph.scope?.label ?? "scope unavailable"} · ${currentBinderPath(binders, currentBinderId)}`);
				const hint = searchActive
					? rawKeyHint("esc", "clear")
					: [
							rawKeyHint("↑/↓", "navigate"),
							rawKeyHint("enter", "open/actions"),
							rawKeyHint("a", "actions"),
							rawKeyHint("←", "up"),
							rawKeyHint("n", "new Binder"),
							rawKeyHint("/", "filter"),
							rawKeyHint("g", "graph"),
							rawKeyHint("s", "scope"),
							rawKeyHint("r", "refresh"),
							rawKeyHint("esc", "close"),
						].join(theme.fg("muted", " · "));
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
					lines.push(theme.fg("muted", "  No tasks or Binders here"));
					return lines;
				}
				const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
				const end = Math.min(start + maxVisible, filtered.length);
				for (let i = start; i < end; i++) {
					const panelEntry = filtered[i]!;
					const selected = i === selectedIndex;
					const cursor = selected ? theme.fg("accent", "❯") : " ";
					if (panelEntry.type === "binder") {
						const title = selected ? theme.bold(panelEntry.node.binder.title) : panelEntry.node.binder.title;
						const metadata = [
							panelEntry.node.childIds.length > 0
								? `${panelEntry.node.childIds.length} Binder${panelEntry.node.childIds.length === 1 ? "" : "s"}`
								: "",
							panelEntry.node.effectiveLabels.length > 0 ? panelEntry.node.effectiveLabels.join(", ") : "",
							searchActive ? panelEntry.node.path : "",
						].filter(Boolean);
						lines.push(
							truncateToWidth(
								`${cursor}  ${theme.fg("accent", "▸")} ${title}${metadata.length ? theme.fg("dim", ` · ${metadata.join(" · ")}`) : ""}`,
								width,
								"",
							),
						);
						continue;
					}
					const entry = panelEntry.entry;
					const row = entry.task;
					const focus = entry.active ? theme.fg("accent", "▶") : " ";
					const execution = executionById.get(row.id);
					const state = execution?.state ?? row.status;
					const presentation = TASK_STATUS_PRESENTATION[row.status as TaskStatus];
					const glyphStyled =
						state === "invalid"
							? theme.fg("error", "!")
							: presentation
								? theme.fg(presentation.color, presentation.glyph)
								: theme.fg("muted", "?");
					const title = selected ? theme.bold(row.title) : row.title;
					let laterSibling = false;
					for (let candidate = i + 1; candidate < filtered.length; candidate++) {
						const candidateEntry = filtered[candidate];
						if (candidateEntry?.type !== "task") continue;
						if (candidateEntry.entry.depth < entry.depth) break;
						if (candidateEntry.entry.depth === entry.depth) {
							laterSibling = true;
							break;
						}
					}
					const connector = taskTreeConnector({
						depth: entry.depth,
						hasChildren: entry.childCount > 0,
						hasLaterSibling: laterSibling,
					});
					const node = entry.depth === 0 && entry.childCount > 0 ? theme.fg("accent", connector) : theme.fg("dim", connector);
					const gates = Array.isArray(row.extra?.gates) ? row.extra.gates.length : 0;
					const relationParts: string[] = [];
					if (execution) relationParts.push(execution.layer === null ? state : `layer ${execution.layer + 1} · ${state}`);
					if (entry.childCount > 0) relationParts.push(`${entry.childCount} subtask${entry.childCount === 1 ? "" : "s"}`);
					if (entry.dependencies.length > 0) {
						const names = entry.dependencies.map((id) => taskById.get(id)?.title ?? id);
						relationParts.push(`needs ${names.join(", ")}`);
					}
					if (gates > 0) relationParts.push(`${gates} gate${gates === 1 ? "" : "s"}`);
					if (row.labels.length > 0) relationParts.push(row.labels.join(", "));
					const inheritedLabels = inheritedLabelsFor(row.id, binders);
					if (inheritedLabels.length > 0) relationParts.push(`inherits ${inheritedLabels.join(", ")}`);
					if (searchActive) relationParts.push(artifactBinderPath(row, binders));
					const relationText = relationParts.length > 0 ? theme.fg("dim", ` · ${relationParts.join(" · ")}`) : "";
					lines.push(truncateToWidth(`${cursor}${focus} ${node} ${glyphStyled} ${title}${relationText}`, width, ""));
				}
				const hasScroll = start > 0 || end < filtered.length;
				lines.push(
					theme.fg("muted", `  ${hasScroll ? `${selectedIndex + 1}/${filtered.length} · ` : ""}↑/↓ navigate · Enter open/actions`),
				);
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
					if (matchesKey(data, "escape")) {
						searchActive = false;
						applyFilter();
					} else if (matchesKey(data, "enter")) {
						searchActive = false;
					} else {
						searchInput.handleInput(data);
						applyFilter();
					}
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "up")) selectedIndex = (selectedIndex - 1 + filtered.length) % Math.max(filtered.length, 1);
				else if (matchesKey(data, "down")) selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1);
				else if (data === "/") searchActive = true;
				else if (data === "n") {
					done({ type: "create-binder" });
					return;
				} else if (matchesKey(data, "left") || data === "\x7f") {
					const parentId = currentBinderId ? binders.nodes.find((node) => node.binder.id === currentBinderId)?.parentId : undefined;
					done({ type: "navigate", ...(parentId ? { binderId: parentId } : {}) });
					return;
				} else if (data === "g") {
					done({ type: "graph" });
					return;
				} else if (data === "s") {
					done({ type: "scope" });
					return;
				} else if (data === "r") {
					done({ type: "refresh" });
					return;
				} else if (data === "a") {
					const panelEntry = filtered[selectedIndex];
					if (panelEntry?.type === "binder") done({ type: "binder-action", binder: panelEntry.node });
					else if (panelEntry?.type === "task") done({ type: "action", row: panelEntry.entry.task });
					return;
				} else if (matchesKey(data, "enter")) {
					const panelEntry = filtered[selectedIndex];
					if (panelEntry?.type === "binder") done({ type: "navigate", binderId: panelEntry.node.binder.id });
					else if (panelEntry?.type === "task") done({ type: "action", row: panelEntry.entry.task });
					return;
				} else if (matchesKey(data, "escape")) {
					done(undefined);
					return;
				} else return;
				tui.requestRender();
			},
		};
	});
}
