import type { DisplayGraph, RenderedGraph } from "../display-graph/display-graph.ts";

export interface GraphRenderer {
	render(graph: DisplayGraph): RenderedGraph;
}
