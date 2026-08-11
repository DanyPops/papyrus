import { type Artifact, TOOL_DETAILS_MAX_EDGES, TOOL_DETAILS_MAX_ITEMS } from "@danypops/papyrus";
import {
	artifactSummary,
	completeness,
	isBoundedString,
	isRecord,
	PAPYRUS_TOOL_DETAILS_SCHEMA,
	type ResultCompleteness,
	type ToolArtifactSummary,
	type ToolDetailsBase,
} from "./shared.ts";

export interface ToolGraphEdge {
	from: string;
	relation: string;
	to: string;
}

export interface GraphToolDetails extends ToolDetailsBase {
	kind: "graph";
	nodes: ToolArtifactSummary[];
	edges: ToolGraphEdge[];
	nodeCompleteness: ResultCompleteness;
	edgeCompleteness: ResultCompleteness;
}

export function createGraphDetails(operation: string, artifacts: readonly Artifact[], edges: readonly ToolGraphEdge[]): GraphToolDetails {
	const nodes = artifacts.slice(0, TOOL_DETAILS_MAX_ITEMS).map(artifactSummary);
	const boundedEdges = edges.slice(0, TOOL_DETAILS_MAX_EDGES).map((edge) => ({ ...edge }));
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "graph",
		operation,
		nodes,
		edges: boundedEdges,
		nodeCompleteness: completeness(artifacts.length, nodes.length),
		edgeCompleteness: completeness(edges.length, boundedEdges.length),
	};
}

export function isGraphEdge(value: unknown): value is ToolGraphEdge {
	return isRecord(value) && isBoundedString(value.from) && isBoundedString(value.relation) && isBoundedString(value.to);
}
