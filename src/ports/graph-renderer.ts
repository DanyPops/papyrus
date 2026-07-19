import type { DisplayGraph, RenderedGraph } from "../domain/display-graph.ts";

export interface GraphRenderer {
	render(graph: DisplayGraph): RenderedGraph;
}
