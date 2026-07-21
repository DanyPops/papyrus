import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { TOOL_COLLAPSED_ROW_LIMIT } from "../../../src/constants.ts";
import { countSummary, expandHint, kindGlyph, statusGlyph, treeConnector } from "./artifact-card.ts";
import type {
	ArtifactListToolDetails,
	GraphToolDetails,
	ToolArtifactSummary,
} from "./render-model.ts";

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
	return [
		theme.fg("muted", `${statusGlyph(row.status)} ${row.status}`),
		theme.fg("accent", identity),
		theme.fg("text", row.title),
	].join("  ");
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
		const lines = [truncateToWidth(
			this.theme.fg("toolTitle", this.theme.bold(`${countSummary(rows.length, this.details.total)} ${noun}`)),
			safeWidth,
		)];
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

interface HierarchyRow {
	node: ToolArtifactSummary;
	prefix: string;
	connector: string;
}

function hierarchyRows(details: GraphToolDetails): HierarchyRow[] {
	const byId = new Map(details.nodes.map((node) => [node.id, node]));
	const childIds = new Map<string, string[]>();
	const contained = new Set<string>();
	for (const edge of details.edges) {
		if (edge.relation !== "contains" || !byId.has(edge.from) || !byId.has(edge.to)) continue;
		const children = childIds.get(edge.from) ?? [];
		children.push(edge.to);
		childIds.set(edge.from, children);
		contained.add(edge.to);
	}
	const roots = details.nodes.filter((node) => !contained.has(node.id));
	const rows: HierarchyRow[] = [];
	const visited = new Set<string>();
	const visit = (node: ToolArtifactSummary, prefix: string, connector: string): void => {
		if (visited.has(node.id)) return;
		visited.add(node.id);
		rows.push({ node, prefix, connector });
		const children = (childIds.get(node.id) ?? []).map((id) => byId.get(id)).filter((child): child is ToolArtifactSummary => child !== undefined);
		children.forEach((child, index) => {
			const last = index === children.length - 1;
			visit(child, `${prefix}${connector ? (connector === "└─" ? "  " : "│ ") : ""}`, treeConnector(last));
		});
	};
	for (const root of roots) visit(root, "", "");
	for (const node of details.nodes) visit(node, "", "");
	return rows;
}

/** Bounded task containment preview; dependency graphs use the dedicated graph renderer. */
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
		const rows = hierarchyRows(this.details);
		const lines = [truncateToWidth(
			this.theme.fg("toolTitle", this.theme.bold(`${this.details.nodes.length} tasks · ${this.details.edges.length} edges`)),
			safeWidth,
		)];
		for (const row of rows) {
			const identity = this.expanded ? `${row.node.id}  ` : "";
			lines.push(truncateToWidth(
				`${row.prefix}${row.connector}${row.connector ? " " : ""}${this.theme.fg("accent", kindGlyph(row.node.kind))} ${this.theme.fg("muted", statusGlyph(row.node.status))} ${this.theme.fg("accent", identity)}${this.theme.fg("text", row.node.title)}`,
				safeWidth,
			));
			if (this.expanded) {
				const metadata = rowMetadata(row.node);
				if (metadata) lines.push(truncateToWidth(this.theme.fg("dim", `${row.prefix}   ${metadata}`), safeWidth));
			}
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
