import { renderMermaidASCII } from "beautiful-mermaid";
import {
	GRAPH_RENDER_BOX_PADDING,
	GRAPH_RENDER_MAX_FALLBACK_LINES,
	GRAPH_RENDER_MAX_ROUTED_EDGES,
	GRAPH_RENDER_MAX_ROUTED_NODES,
	GRAPH_RENDER_PADDING_X,
	GRAPH_RENDER_PADDING_Y,
} from "../../src/constants.ts";
import type { DisplayGraph, RenderedGraph } from "../../src/domain/display-graph.ts";
import type { GraphRenderer } from "../../src/ports/graph-renderer.ts";

function nodeLabel(label: string): string {
	return label.replace(/\s+/g, " ").trim().replaceAll('"', "'");
}

function edgeLabel(label: string): string {
	return label.replace(/\s+/g, " ").trim().replaceAll("|", "/");
}

export function mermaidSource(graph: DisplayGraph): string {
	const aliases = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
	const lines = [`flowchart ${graph.direction}`];
	for (const node of graph.nodes) lines.push(`  ${aliases.get(node.id)}["${nodeLabel(node.label)}"]`);
	for (const edge of graph.edges) {
		const from = aliases.get(edge.from);
		const to = aliases.get(edge.to);
		if (!from || !to) continue;
		lines.push(edge.label
			? `  ${from} -->|${edgeLabel(edge.label)}| ${to}`
			: `  ${from} --> ${to}`);
	}
	return lines.join("\n");
}

function boundedLineFallback(graph: DisplayGraph): RenderedGraph {
	const candidates = [
		"┌─ Task graph ─",
		`│ ${graph.nodes.length} nodes · ${graph.edges.length} edges · routed layout skipped above ${GRAPH_RENDER_MAX_ROUTED_NODES} nodes`,
		"├─ Nodes",
		...graph.nodes.map((node) => `│ ${node.label}`),
		"├─ Edges",
		...graph.edges.map((edge) => `│ ${edge.from} ─${edge.label ? `${edge.label}─` : ""}→ ${edge.to}`),
	];
	const contentLimit = Math.max(1, GRAPH_RENDER_MAX_FALLBACK_LINES - 1);
	const lines = candidates.slice(0, contentLimit);
	const omitted = candidates.length - lines.length;
	if (omitted > 0) lines[lines.length - 1] = `│ … ${omitted + 1} lines omitted`;
	lines.push("└─");
	return { lines };
}

export class BeautifulMermaidRenderer implements GraphRenderer {
	render(graph: DisplayGraph): RenderedGraph {
		if (graph.nodes.length === 0) return { lines: [] };
		if (graph.nodes.length > GRAPH_RENDER_MAX_ROUTED_NODES || graph.edges.length > GRAPH_RENDER_MAX_ROUTED_EDGES) {
			return boundedLineFallback(graph);
		}
		const output = renderMermaidASCII(mermaidSource(graph), {
			useAscii: false,
			paddingX: GRAPH_RENDER_PADDING_X,
			paddingY: GRAPH_RENDER_PADDING_Y,
			boxBorderPadding: GRAPH_RENDER_BOX_PADDING,
			colorMode: "none",
		});
		return { lines: output.replace(/\s+$/g, "").split("\n") };
	}
}
