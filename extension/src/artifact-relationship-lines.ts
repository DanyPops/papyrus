import { GRAPH_RENDER_MAX_ROUTED_EDGES, GRAPH_RENDER_MAX_ROUTED_NODES } from "../../src/constants.ts";
import { projectArtifactRelationships } from "../../src/artifact-relationship-view.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { GraphRenderer } from "../../src/ports/graph-renderer.ts";

/**
 * Renders an artifact's direct relationships as a small graph when the neighbor set is real
 * (more than one node) and within the same bound Task graph rendering already enforces;
 * otherwise falls back to a plain, still name-resolved arrow list -- never the renderer's own
 * separate box-style fallback, so this view has exactly two shapes, not three.
 */
export function buildArtifactRelationshipLines(artifact: Artifact, renderer: GraphRenderer): string[] {
	const graph = projectArtifactRelationships(artifact);
	if (graph.edges.length === 0) return [];
	const withinBounds = graph.nodes.length > 1
		&& graph.nodes.length <= GRAPH_RENDER_MAX_ROUTED_NODES
		&& graph.edges.length <= GRAPH_RENDER_MAX_ROUTED_EDGES;
	if (withinBounds) {
		const rendered = renderer.render(graph);
		if (rendered.lines.length > 0) return rendered.lines;
	}
	const labelById = new Map(graph.nodes.map((node) => [node.id, node.label]));
	return graph.edges.map((edge) => `${labelById.get(edge.from) ?? edge.from} --${edge.label}--> ${labelById.get(edge.to) ?? edge.to}`);
}
