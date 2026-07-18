import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SEED_RELATIONS } from "../../src/constants.ts";
import type { Artifact } from "../../src/ops.ts";
import type { OperationName } from "../../src/service.ts";
import { formatMetadata } from "./artifact-format.ts";
import { callService } from "./service-client.ts";

const BROWSER_QUERY_LIMIT = 500;
const BROWSER_VISIBLE_ROWS = 20;
const DETAIL_GRAPH_DEPTH = 4;
const DETAIL_GRAPH_NODES = 100;

export interface ArtifactBrowserConfig {
	kind: string;
	title: string;
	statusOrder: string[];
	glyphs: Record<string, string>;
	listOperation?: OperationName;
	rowMeta(row: Artifact): string;
	actions(row: Artifact): string[];
	handleAction(choice: string, row: Artifact, ctx: ExtensionCommandContext): Promise<void>;
}

export function filterArtifactRows(rows: Artifact[], query: string): Artifact[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...rows];
	return rows.filter((row) => [
		row.id,
		row.title,
		row.body,
		row.subtype,
		row.labels.join(" "),
		JSON.stringify(row.extra),
	].some((value) => value.toLowerCase().includes(needle)));
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
	});
}

export async function showArtifactDetails(
	ctx: ExtensionCommandContext,
	id: string,
	operation: OperationName = "artifact.show",
): Promise<void> {
	const artifact = await callService<Record<string, unknown>, Artifact | null>(operation, {
		id,
		tree: true,
		depth: DETAIL_GRAPH_DEPTH,
		max_nodes: DETAIL_GRAPH_NODES,
	});
	if (!artifact) { ctx.ui.notify(`Artifact ${id} not found`, "error"); return; }
	let output = `${artifact.title}\n${artifact.id} [${artifact.kind}|${artifact.status}]`;
	if (artifact.subtype) output += ` · ${artifact.subtype}`;
	if (artifact.body) output += `\n\n${artifact.body}`;
	if (artifact.labels.length > 0) output += `\n\nLabels: ${artifact.labels.join(", ")}`;
	if (Object.keys(artifact.extra).length > 0) {
		output += `\n\nMetadata:\n${formatMetadata(artifact.extra).map((line) => `  ${line}`).join("\n")}`;
	}
	if (artifact.edges?.length) {
		output += `\n\nEdges:\n${artifact.edges.map((edge) => `  ${edge.from} --${edge.relation}--> ${edge.to}`).join("\n")}`;
	}
	ctx.ui.notify(output, "info");
}

export async function linkFromArtifact(ctx: ExtensionCommandContext, fromId: string, fixedRelation?: string): Promise<void> {
	const target = await ctx.ui.input("Target artifact id:", "");
	if (!target) return;
	const relation = fixedRelation ?? await ctx.ui.select("Relation", [...SEED_RELATIONS]);
	if (!relation) return;
	try {
		await callService("graph.link", { from: fromId, relation, to: target });
		ctx.ui.notify(`Linked ${fromId} --${relation}--> ${target}`, "info");
	} catch (error) {
		ctx.ui.notify(`Link failed: ${error instanceof Error ? error.message : error}`, "error");
	}
}

export async function setArtifactStatus(ctx: ExtensionCommandContext, id: string, status: string): Promise<void> {
	try {
		const artifact = await callService<Record<string, unknown>, Artifact | null>("graph.status", { id, status });
		if (!artifact) { ctx.ui.notify(`Artifact ${id} not found`, "error"); return; }
		ctx.ui.notify(`${artifact.id} → [${artifact.status}]`, "info");
	} catch (error) {
		ctx.ui.notify(`Status change failed: ${error instanceof Error ? error.message : error}`, "error");
	}
}

export async function showArtifactBrowser(ctx: ExtensionCommandContext, config: ArtifactBrowserConfig): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`/${config.kind}s requires interactive mode`, "warning");
		return;
	}
	let rows = await loadArtifacts(config);
	if (rows.length === 0) {
		ctx.ui.notify(`No ${config.kind} artifacts yet. Ask the agent to create one.`, "info");
		return;
	}

	for (;;) {
		const selected = await renderPanel(ctx, rows, config);
		if (selected === undefined) return;
		if (selected === "refresh") { rows = await loadArtifacts(config); continue; }
		const choices = config.actions(selected);
		const choice = await ctx.ui.select(selected.title, choices);
		if (!choice) continue;
		await config.handleAction(choice, selected, ctx);
		rows = await loadArtifacts(config);
	}
}

function renderPanel(
	ctx: ExtensionCommandContext,
	rows: Artifact[],
	config: ArtifactBrowserConfig,
): Promise<Artifact | "refresh" | undefined> {
	return ctx.ui.custom<Artifact | "refresh" | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input();
		let searchActive = false;
		let filtered = [...rows];
		let selectedIndex = 0;

		function applyFilter(): void {
			filtered = filterArtifactRows(rows, input.getValue());
			selectedIndex = 0;
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
				const title = theme.bold(config.title);
				const hint = searchActive
					? rawKeyHint("esc", "clear")
					: [rawKeyHint("enter", "actions"), rawKeyHint("/", "filter"), rawKeyHint("r", "refresh"), rawKeyHint("esc", "close")]
						.join(theme.fg("muted", " · "));
				const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
				const summary = statusSummary(rows, config.statusOrder)
					.map(({ status, count }) => `${config.glyphs[status] ?? status} ${count} ${status}`)
					.join(", ");
				return [
					truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""),
					truncateToWidth(theme.fg("muted", summary), width, ""),
				];
			},
		};

		const list = {
			invalidate() {},
			render(width: number): string[] {
				const lines = searchActive ? [...input.render(width), ""] : [""];
				if (filtered.length === 0) return [...lines, theme.fg("muted", `  No matching ${config.kind}s`)];
				const start = Math.max(0, Math.min(selectedIndex - Math.floor(BROWSER_VISIBLE_ROWS / 2), filtered.length - BROWSER_VISIBLE_ROWS));
				const end = Math.min(start + BROWSER_VISIBLE_ROWS, filtered.length);
				for (let index = start; index < end; index++) {
					const row = filtered[index]!;
					const selected = index === selectedIndex;
					const cursor = selected ? theme.fg("accent", "❯") : " ";
					const glyph = config.glyphs[row.status] ?? "?";
					const title = selected ? theme.bold(row.title) : row.title;
					const meta = config.rowMeta(row);
					lines.push(truncateToWidth(`${cursor} ${glyph} ${title}${meta ? theme.fg("dim", ` · ${meta}`) : ""}`, width, ""));
				}
				lines.push(theme.fg("muted", `  ${selectedIndex + 1}/${filtered.length} ${config.kind}`));
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
					if (data === "\x1b") { searchActive = false; applyFilter(); }
					else if (data === "\r") searchActive = false;
					else { input.handleInput(data); applyFilter(); }
					tui.requestRender();
					return;
				}
				switch (data) {
					case "\x1b[A": selectedIndex = (selectedIndex - 1 + filtered.length) % Math.max(filtered.length, 1); break;
					case "\x1b[B": selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1); break;
					case "/": searchActive = true; break;
					case "r": done("refresh"); return;
					case "\r": { const row = filtered[selectedIndex]; if (row) done(row); return; }
					case "\x1b": done(undefined); return;
					default: return;
				}
				tui.requestRender();
			},
		};
	});
}
