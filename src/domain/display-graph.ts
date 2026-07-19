export type GraphDirection = "TD" | "LR";

export interface DisplayGraphNode {
	id: string;
	label: string;
	status?: string;
}

export interface DisplayGraphEdge {
	from: string;
	to: string;
	label?: string;
}

export interface DisplayGraph {
	direction: GraphDirection;
	nodes: DisplayGraphNode[];
	edges: DisplayGraphEdge[];
}

export interface RenderedGraph {
	lines: string[];
}
