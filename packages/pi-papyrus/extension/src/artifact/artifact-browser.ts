import { type Artifact, type BinderNode, type BinderTree, type OperationName, SEED_RELATIONS } from "@danypops/papyrus";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	Input,
	matchesKey,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { callService } from "../service-client.ts";
import { showArtifactDetailView } from "./artifact-detail-view.ts";
import { ArtifactNavigationState } from "./artifact-navigation-state.ts";
import type { StatusPresentation } from "./artifact-status-presentation.ts";
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
	removeBinderInteractive,
} from "./binder-navigation.ts";

export { artifactDetailsText } from "./artifact-detail-format.ts";

const BROWSER_QUERY_LIMIT = 500;
const BROWSER_VISIBLE_ROWS = 20;
const DETAIL_GRAPH_DEPTH = 4;
const DETAIL_GRAPH_NODES = 100;

export interface ArtifactBrowserConfig {
	kind: string;
	title: string;
	statusOrder: string[];
	presentation: Record<string, StatusPresentation>;
	listOperation?: OperationName;
	listInput?: Record<string, unknown>;
	/** Enables the Binder filesystem projection. Flat browsers such as Notes/Discuss remain unchanged. */
	hierarchical?: boolean;
	rowMeta(row: Artifact, theme: Theme): string;
	actions(row: Artifact): string[];
	handleAction(choice: string, row: Artifact, ctx: ExtensionCommandContext): Promise<void>;
}

export function artifactActivationEnabled(artifact: Pick<Artifact, "extra">): boolean {
	const activation = artifact.extra.activation;
	return !(
		typeof activation === "object" &&
		activation !== null &&
		!Array.isArray(activation) &&
		(activation as Record<string, unknown>).enabled === false
	);
}

export function filterArtifactRows(rows: Artifact[], query: string): Artifact[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...rows];
	return rows.filter((row) =>
		// List operations commonly hand back ArtifactSummary rows (body/extra omitted for cheap
		// listing) rather than the full Artifact this type declares -- body/subtype/extra can be
		// undefined at runtime here despite the type saying string, so every value is normalized
		// to "" before lowercasing instead of assuming it's always a real string.
		[row.id, row.title, row.body, row.subtype, row.labels.join(" "), row.extra ? JSON.stringify(row.extra) : undefined].some((value) =>
			(value ?? "").toLowerCase().includes(needle),
		),
	);
}

export function statusSummary(rows: Artifact[], order: string[]): Array<{ status: string; count: number }> {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
	return order.filter((status) => counts.has(status)).map((status) => ({ status, count: counts.get(status)! }));
}

async function loadArtifacts(config: ArtifactBrowserConfig): Promise<Artifact[]> {
	return callService<Record<string, unknown>, Artifact[]>(config.listOperation ?? "artifact.query", {
		kind: config.kind,
		limit: BROWSER_QUERY_LIMIT,
		...(config.listInput ?? {}),
	});
}

export type ArtifactDetailLoader = (operation: OperationName, input: Record<string, unknown>) => Promise<Artifact | null>;

const loadArtifactDetails: ArtifactDetailLoader = (operation, input) =>
	callService<Record<string, unknown>, Artifact | null>(operation, input);

export async function showArtifactDetails(
	ctx: ExtensionCommandContext,
	id: string,
	operation: OperationName = "artifact.show",
	input: Record<string, unknown> = {},
	load: ArtifactDetailLoader = loadArtifactDetails,
): Promise<void> {
	try {
		const artifact = await load(operation, {
			id,
			...input,
			tree: true,
			depth: DETAIL_GRAPH_DEPTH,
			max_nodes: DETAIL_GRAPH_NODES,
		});
		if (!artifact) {
			ctx.ui.notify("Artifact not found", "error");
			return;
		}
		await showArtifactDetailView(ctx, artifact);
	} catch (error) {
		ctx.ui.notify(`Show details failed: ${error instanceof Error ? error.message : error}`, "error");
	}
}

export async function linkFromArtifact(ctx: ExtensionCommandContext, fromId: string, fixedRelation?: string): Promise<void> {
	const target = await ctx.ui.input("Target artifact id:", "");
	if (!target) return;
	const relation = fixedRelation ?? (await ctx.ui.select("Relation", [...SEED_RELATIONS]));
	if (!relation) return;
	try {
		await callService("graph.link", { from: fromId, relation, to: target });
		ctx.ui.notify(`Artifacts linked via ${relation}`, "info");
	} catch (error) {
		ctx.ui.notify(`Link failed: ${error instanceof Error ? error.message : error}`, "error");
	}
}

export async function setArtifactStatus(ctx: ExtensionCommandContext, id: string, status: string): Promise<void> {
	try {
		const artifact = await callService<Record<string, unknown>, Artifact | null>("graph.status", { id, status });
		if (!artifact) {
			ctx.ui.notify("Artifact not found", "error");
			return;
		}
		ctx.ui.notify(`${artifact.title} → [${artifact.status}]`, "info");
	} catch (error) {
		ctx.ui.notify(`Status change failed: ${error instanceof Error ? error.message : error}`, "error");
	}
}

async function reloadBrowser(config: ArtifactBrowserConfig, projectRoot: string): Promise<{ rows: Artifact[]; tree?: BinderTree }> {
	const rows = await loadArtifacts(config);
	const tree = config.hierarchical
		? await loadBinderTree(
				projectRoot,
				rows.map((row) => row.id),
			)
		: undefined;
	return { rows, tree };
}

export async function showArtifactBrowser(ctx: ExtensionCommandContext, config: ArtifactBrowserConfig): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`/${config.kind}s requires interactive mode`, "warning");
		return;
	}
	let { rows, tree } = await reloadBrowser(config, ctx.cwd);
	let currentBinderId: string | undefined;
	if (rows.length === 0 && !config.hierarchical) {
		ctx.ui.notify(`No ${config.kind} artifacts yet. Ask the agent to create one.`, "info");
		return;
	}

	for (;;) {
		if (currentBinderId && !tree?.nodes.some((node) => node.binder.id === currentBinderId)) currentBinderId = undefined;
		const selected = await renderPanel(ctx, rows, config, tree, currentBinderId);
		if (!selected) return;
		if (selected.type === "refresh") {
			({ rows, tree } = await reloadBrowser(config, ctx.cwd));
			continue;
		}
		if (selected.type === "navigate") {
			currentBinderId = selected.binderId;
			continue;
		}
		if (selected.type === "create-binder") {
			if (await createBinderInteractive(ctx, currentBinderId)) ({ rows, tree } = await reloadBrowser(config, ctx.cwd));
			continue;
		}
		if (selected.type === "binder-action" && tree) {
			const choice = await ctx.ui.select(selected.node.path, [
				"Open",
				"Create nested Binder",
				"Rename / edit inherited labels",
				"Move Binder",
				"Remove empty Binder",
			]);
			if (!choice) continue;
			if (choice === "Open") {
				currentBinderId = selected.node.binder.id;
				continue;
			}
			let changed = false;
			if (choice === "Create nested Binder") changed = await createBinderInteractive(ctx, selected.node.binder.id);
			else if (choice === "Rename / edit inherited labels") changed = await editBinderInteractive(ctx, selected.node);
			else if (choice === "Move Binder") changed = await moveBinderInteractive(ctx, tree, selected.node);
			else if (choice === "Remove empty Binder") {
				changed = await removeBinderInteractive(ctx, selected.node);
				if (changed && currentBinderId === selected.node.binder.id) currentBinderId = selected.node.parentId;
			}
			if (changed) ({ rows, tree } = await reloadBrowser(config, ctx.cwd));
			continue;
		}
		if (selected.type !== "artifact") continue;
		const choices = [...(tree ? ["Move to Binder"] : []), ...config.actions(selected.row)];
		const choice = await ctx.ui.select(selected.row.title, choices);
		if (!choice) continue;
		if (choice === "Move to Binder" && tree) await moveArtifactInteractive(ctx, tree, selected.row);
		else await config.handleAction(choice, selected.row, ctx);
		({ rows, tree } = await reloadBrowser(config, ctx.cwd));
	}
}

type BrowserEntry = { type: "binder"; node: BinderNode } | { type: "artifact"; row: Artifact };

type BrowserPanelAction =
	| { type: "artifact"; row: Artifact }
	| { type: "binder-action"; node: BinderNode }
	| { type: "navigate"; binderId?: string }
	| { type: "create-binder" }
	| { type: "refresh" };

export function browserEntries(
	rows: Artifact[],
	tree: BinderTree | undefined,
	currentBinderId: string | undefined,
	query: string,
): BrowserEntry[] {
	const needle = query.trim().toLowerCase();
	if (!tree) return filterArtifactRows(rows, query).map((row) => ({ type: "artifact", row }));
	if (needle) {
		return [
			...tree.nodes.filter((node) => binderSearchText(node).includes(needle)).map((node): BrowserEntry => ({ type: "binder", node })),
			...rows.filter((row) => artifactSearchText(row, tree).includes(needle)).map((row): BrowserEntry => ({ type: "artifact", row })),
		].sort((left, right) => {
			const leftPath = left.type === "binder" ? left.node.path : artifactBinderPath(left.row, tree);
			const rightPath = right.type === "binder" ? right.node.path : artifactBinderPath(right.row, tree);
			return leftPath.localeCompare(rightPath);
		});
	}
	return [
		...childBinders(tree, currentBinderId).map((node): BrowserEntry => ({ type: "binder", node })),
		...artifactsInBinder(rows, tree, currentBinderId).map((row): BrowserEntry => ({ type: "artifact", row })),
	];
}

function renderPanel(
	ctx: ExtensionCommandContext,
	rows: Artifact[],
	config: ArtifactBrowserConfig,
	tree: BinderTree | undefined,
	currentBinderId: string | undefined,
): Promise<BrowserPanelAction | undefined> {
	return ctx.ui.custom<BrowserPanelAction | undefined>((tui, theme, keybindings, done) => {
		const input = new Input();
		let filtered = browserEntries(rows, tree, currentBinderId, "");
		const navigation = new ArtifactNavigationState(filtered.length);

		function applyFilter(): void {
			filtered = browserEntries(rows, tree, currentBinderId, navigation.query);
			navigation.setItemCount(filtered.length);
			navigation.first();
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
				const path = tree ? ` · ${currentBinderPath(tree, currentBinderId)}` : "";
				const title = theme.bold(`${config.title}${path}`);
				const hint =
					navigation.mode === "filter"
						? `${theme.fg("accent", "FILTER")} · ${rawKeyHint("enter", "keep")} · ${rawKeyHint("esc", "clear")}`
						: [
								theme.fg("accent", "NORMAL"),
								rawKeyHint("j/k", "move"),
								rawKeyHint("enter/l", "open/actions"),
								...(tree ? [rawKeyHint("a", "actions"), rawKeyHint("h", "up"), rawKeyHint("n", "new Binder")] : []),
								rawKeyHint("/", "filter"),
								rawKeyHint("f", navigation.expanded ? "compact" : "expand"),
								rawKeyHint("q", "close"),
							].join(theme.fg("muted", " · "));
				const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
				const summary = statusSummary(rows, config.statusOrder)
					.map(({ status, count }) => {
						const presentation = config.presentation[status];
						const glyph = presentation ? theme.fg(presentation.color, presentation.glyph) : status;
						return `${glyph} ${count} ${status}`;
					})
					.join(", ");
				const binderSummary = tree ? `${tree.nodes.length} Binder${tree.nodes.length === 1 ? "" : "s"}` : "";
				return [
					truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""),
					truncateToWidth(theme.fg("muted", [summary, binderSummary].filter(Boolean).join(" · ")), width, ""),
				];
			},
		};

		const list = {
			invalidate() {},
			render(width: number): string[] {
				const lines = navigation.mode === "filter" ? [...input.render(width), ""] : [""];
				if (filtered.length === 0) return [...lines, theme.fg("muted", `  No ${tree ? "items" : `matching ${config.kind}s`}`)];
				const visibleRows = navigation.expanded ? Math.max(BROWSER_VISIBLE_ROWS, tui.terminal.rows - 10) : BROWSER_VISIBLE_ROWS;
				const start = Math.max(0, Math.min(navigation.selectedIndex - Math.floor(visibleRows / 2), filtered.length - visibleRows));
				const end = Math.min(start + visibleRows, filtered.length);
				for (let index = start; index < end; index++) {
					const entry = filtered[index]!;
					const selected = index === navigation.selectedIndex;
					const cursor = selected ? theme.fg("accent", "❯") : " ";
					if (entry.type === "binder") {
						const title = selected ? theme.bold(entry.node.binder.title) : entry.node.binder.title;
						const details = [
							entry.node.childIds.length > 0 ? `${entry.node.childIds.length} Binder${entry.node.childIds.length === 1 ? "" : "s"}` : "",
							entry.node.effectiveLabels.length > 0 ? entry.node.effectiveLabels.join(", ") : "",
							navigation.mode === "filter" ? entry.node.path : "",
						].filter(Boolean);
						lines.push(
							truncateToWidth(
								`${cursor} ${theme.fg("accent", "▸")} ${title}${details.length ? theme.fg("dim", ` · ${details.join(" · ")}`) : ""}`,
								width,
								"",
							),
						);
						continue;
					}
					const row = entry.row;
					const presentation = config.presentation[row.status];
					const glyph = presentation ? theme.fg(presentation.color, presentation.glyph) : "?";
					const title = selected ? theme.bold(row.title) : row.title;
					const inherited = tree ? inheritedLabelsFor(row.id, tree) : [];
					const details = [
						config.rowMeta(row, theme),
						inherited.length > 0 ? `inherits ${inherited.join(", ")}` : "",
						tree && navigation.mode === "filter" ? artifactBinderPath(row, tree) : "",
					].filter(Boolean);
					lines.push(
						truncateToWidth(
							`${cursor} ${glyph} ${title}${details.length ? `${theme.fg("dim", " · ")}${details.join(theme.fg("dim", " · "))}` : ""}`,
							width,
							"",
						),
					);
				}
				lines.push(theme.fg("muted", `  ${navigation.selectedIndex + 1}/${filtered.length} item${filtered.length === 1 ? "" : "s"}`));
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

		let focused = false;
		return {
			get focused(): boolean {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				input.focused = value && navigation.mode === "filter";
			},
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (navigation.mode === "filter") {
					if (matchesKey(data, "escape")) {
						navigation.leaveFilter(true);
						input.setValue(navigation.query);
						input.focused = false;
						applyFilter();
					} else if (matchesKey(data, "enter")) {
						navigation.leaveFilter();
						input.focused = false;
					} else {
						input.handleInput(data);
						navigation.setQuery(input.getValue());
						applyFilter();
					}
					tui.requestRender();
					return;
				}

				const selectedEntry = () => filtered[navigation.selectedIndex];
				const openSelected = (): void => {
					const entry = selectedEntry();
					if (entry?.type === "binder") done({ type: "navigate", binderId: entry.node.binder.id });
					else if (entry?.type === "artifact") done({ type: "artifact", row: entry.row });
				};
				if (keybindings.matches?.(data, "tui.select.up") === true || matchesKey(data, "up") || data === "k") navigation.move(-1);
				else if (keybindings.matches?.(data, "tui.select.down") === true || matchesKey(data, "down") || data === "j") navigation.move(1);
				else if (keybindings.matches?.(data, "tui.select.pageUp") === true || matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u"))
					navigation.movePage(
						-1,
						Math.max(
							1,
							Math.floor((navigation.expanded ? Math.max(BROWSER_VISIBLE_ROWS, tui.terminal.rows - 10) : BROWSER_VISIBLE_ROWS) / 2),
						),
					);
				else if (keybindings.matches?.(data, "tui.select.pageDown") === true || matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d"))
					navigation.movePage(
						1,
						Math.max(
							1,
							Math.floor((navigation.expanded ? Math.max(BROWSER_VISIBLE_ROWS, tui.terminal.rows - 10) : BROWSER_VISIBLE_ROWS) / 2),
						),
					);
				else if (data === "g") navigation.first();
				else if (data === "G") navigation.last();
				else if (data === "/") {
					navigation.enterFilter();
					input.focused = focused;
				} else if (data === "f") navigation.toggleExpanded();
				else if (tree && data === "n") {
					done({ type: "create-binder" });
					return;
				} else if (
					tree &&
					(keybindings.matches?.(data, "tui.editor.cursorLeft") === true || matchesKey(data, "left") || data === "h" || data === "\x7f")
				) {
					const parentId = currentBinderId ? tree.nodes.find((node) => node.binder.id === currentBinderId)?.parentId : undefined;
					done({ type: "navigate", ...(parentId ? { binderId: parentId } : {}) });
					return;
				} else if (data === "r") {
					done({ type: "refresh" });
					return;
				} else if (tree && data === "a") {
					const entry = selectedEntry();
					if (entry?.type === "binder") done({ type: "binder-action", node: entry.node });
					else if (entry?.type === "artifact") done({ type: "artifact", row: entry.row });
					return;
				} else if (keybindings.matches?.(data, "tui.select.confirm") === true || matchesKey(data, "enter") || data === "l") {
					openSelected();
					return;
				} else if (
					keybindings.matches?.(data, "tui.select.cancel") === true ||
					matchesKey(data, "escape") ||
					matchesKey(data, "ctrl+c") ||
					data === "q"
				) {
					done(undefined);
					return;
				} else return;
				tui.requestRender();
			},
		} satisfies Component & Focusable;
	});
}
