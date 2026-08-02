import { TOOL_COLLAPSED_ROW_LIMIT } from "@danypops/papyrus";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { type TreeNode, TreeView } from "malevich-tui-components";
import { countSummary, expandHint, kindGlyph, statusGlyph } from "./artifact-card.ts";
import type { ArtifactListToolDetails, GraphToolDetails, ToolArtifactSummary } from "./render-model.ts";

function pluralKind(rows: readonly ToolArtifactSummary[]): string {
	const kind = rows[0]?.kind ?? "artifact";
	if (kind === "task") return "tasks";
	if (kind === "doc") return "documents";
	if (kind === "skill") return "skills";
	if (kind === "rule") return "rules";
	return "artifacts";
}

function statusSummary(rows: readonly ToolArtifactSummary[]): string {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
	return [...counts.entries()].map(([status, count]) => `${status} ${count}`).join(" · ");
}

function rowLine(row: ToolArtifactSummary, expanded: boolean, theme: Theme): string {
	const identity = expanded ? `${row.id}  ` : "";
	return [theme.fg("muted", `${statusGlyph(row.status)} ${row.status}`), theme.fg("accent", identity), theme.fg("text", row.title)].join(
		"  ",
	);
}

function rowMetadata(row: ToolArtifactSummary): string {
	return [row.subtype, ...row.labels].filter(Boolean).join(" · ");
}

/** Bounded collapsed/expanded artifact collection presentation. */
export class ArtifactListCard implements Component {
	private details: ArtifactListToolDetails;
	private theme: Theme;
	private expanded: boolean;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(details: ArtifactListToolDetails, theme: Theme, expanded: boolean) {
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
	}

	update(details: ArtifactListToolDetails, theme: Theme, expanded: boolean): void {
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;
		const rows = this.details.rows;
		const noun = pluralKind(rows);
		const lines = [
			truncateToWidth(this.theme.fg("toolTitle", this.theme.bold(`${countSummary(rows.length, this.details.total)} ${noun}`)), safeWidth),
		];
		if (rows.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("dim", `No ${noun}.`), safeWidth));
		} else {
			lines.push(truncateToWidth(this.theme.fg("muted", statusSummary(rows)), safeWidth));
			const display = this.expanded ? rows : rows.slice(0, TOOL_COLLAPSED_ROW_LIMIT);
			for (const row of display) {
				lines.push(truncateToWidth(rowLine(row, this.expanded, this.theme), safeWidth));
				if (this.expanded) {
					const metadata = rowMetadata(row);
					if (metadata) lines.push(truncateToWidth(this.theme.fg("dim", `  ${metadata}`), safeWidth));
				}
			}
			const omitted = Math.max(0, this.details.total - display.length);
			if (omitted > 0) lines.push(truncateToWidth(this.theme.fg("dim", `${omitted} more · ${expandHint()}`), safeWidth));
		}
		this.cachedWidth = safeWidth;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** A fixed-text Component embedding one already-styled, width-truncated
 * line -- used for the dependency-edge annotation Malevich's TreeView
 * renders indented beneath a node. */
function textLine(text: string): Component {
	return {
		render: (width: number) => text.split("\n").map((line) => truncateToWidth(line, width)),
		invalidate: () => {},
	};
}

/** Projects GraphToolDetails' containment edges (`relation === "contains"`)
 * into Malevich TreeNodes, rendered via the real, shared TreeView instead
 * of hand-rolled connector math. Any non-containment edge (depends_on,
 * references, blocks, ...) naming a node as its `to` -- previously
 * silently dropped entirely -- surfaces as a "depends on: ..." annotation
 * embedded under that node, matching DagView's own edge-annotation wording. */
function toTreeNodes(details: GraphToolDetails, theme: Theme, expanded: boolean): TreeNode[] {
	const byId = new Map(details.nodes.map((node) => [node.id, node]));
	const childIds = new Map<string, string[]>();
	const contained = new Set<string>();
	const dependencySources = new Map<string, string[]>();
	for (const edge of details.edges) {
		if (edge.relation === "contains") {
			if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
			const children = childIds.get(edge.from) ?? [];
			children.push(edge.to);
			childIds.set(edge.from, children);
			contained.add(edge.to);
		} else if (byId.has(edge.to)) {
			const sources = dependencySources.get(edge.to) ?? [];
			sources.push(edge.from);
			dependencySources.set(edge.to, sources);
		}
	}

	const visited = new Set<string>();
	const buildNode = (node: ToolArtifactSummary): TreeNode => {
		visited.add(node.id);
		const identity = expanded ? `${node.id}  ` : "";
		const label = `${theme.fg("accent", kindGlyph(node.kind))} ${theme.fg("muted", statusGlyph(node.status))} ${theme.fg("accent", identity)}${theme.fg("text", node.title)}`;
		const children: TreeNode[] = [];
		for (const id of childIds.get(node.id) ?? []) {
			if (visited.has(id)) continue;
			const child = byId.get(id);
			if (child) children.push(buildNode(child));
		}
		const metadata = expanded ? rowMetadata(node) : "";
		const sources = dependencySources.get(node.id);
		const annotations = [
			...(metadata ? [theme.fg("dim", metadata)] : []),
			...(sources && sources.length > 0
				? [theme.fg("dim", `depends on: ${sources.map((id) => byId.get(id)?.title ?? id).join(", ")}`)]
				: []),
		];
		return {
			label,
			children: children.length > 0 ? children : undefined,
			component: annotations.length > 0 ? textLine(annotations.join("\n")) : undefined,
		};
	};

	const tree: TreeNode[] = [];
	for (const root of details.nodes.filter((node) => !contained.has(node.id))) {
		if (!visited.has(root.id)) tree.push(buildNode(root));
	}
	for (const node of details.nodes) {
		if (!visited.has(node.id)) tree.push(buildNode(node));
	}
	return tree;
}

/** Bounded task containment preview; dependency edges surface as an
 * annotation under the node they target (see toTreeNodes). */
export class TaskHierarchyPreview implements Component {
	private details: GraphToolDetails;
	private theme: Theme;
	private expanded: boolean;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(details: GraphToolDetails, theme: Theme, expanded: boolean) {
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
	}

	update(details: GraphToolDetails, theme: Theme, expanded: boolean): void {
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;
		const header = truncateToWidth(
			this.theme.fg("toolTitle", this.theme.bold(`${this.details.nodes.length} tasks · ${this.details.edges.length} edges`)),
			safeWidth,
		);
		const tree = new TreeView({ nodes: toTreeNodes(this.details, this.theme, this.expanded) });
		const lines = [header, ...tree.render(safeWidth)];
		this.cachedWidth = safeWidth;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
